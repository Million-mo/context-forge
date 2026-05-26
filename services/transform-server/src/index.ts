import express from "express"
import type { Request, Response } from "express"
import { createHash } from "crypto"
import { resolve } from "path"
import type { TurnSummary } from "./types.js"
import { LLMClient, createLLMClient, serializeMessages } from "./llm.js"
import { SummaryIndex } from "./summary-index.js"
import { config } from "./config.js"

const app = express()
app.use(express.json({ limit: "10mb" }))

// ─── Types ───────────────────────────────────────────────────────────────────

type BucketHashes = Record<number, string>

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

type ToolOutputEntry = {
  idx: number
  lastCallIdx: number
  callCount: number
  toolType: string
  compressed: boolean
  level: CompressionLevel
  originalOutput: string
  compressedOutput: string
  timestamp: number
  lastCallTime: number
}

interface Turn {
  index: number
  startIdx: number       // first message index of this turn
  endIdx: number         // exclusive
  messages: any[]
  isCurrent: boolean
  messageCount: number
  tokenEstimate: number
  compressedMessages: any[]
  summary?: TurnSummary  // LLM-generated summary (filled async)
}

type SessionStore = {
  // All messages in order (source of truth)
  source: any[]
  // Per-turn storage
  turns: Turn[]
  // Last known turn count from client (for detecting new completed turns)
  lastKnownTurnCount: number
  // Compression state
  compressedBucketHashes: BucketHashes
  toolOutputs: Map<string, ToolOutputEntry>
  createdAt: number
  // Summary index (one per session)
  summaryIndex: SummaryIndex
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/
const MAX_TOOL_OUTPUTS_PER_SESSION = 10000

// ─── Configuration ────────────────────────────────────────────────────────────

const { server } = config

const BUCKET_SIZE = server.bucketSize
const MAX_HOT_TURNS = server.maxHotTurns

const DECAY_WEIGHTS = server.decayWeights

const TOOL_DECAY_MODIFIERS: Record<string, number> = {
  read: 0.8,
  glob: 0.6,
  grep: 0.7,
  webfetch: 1.5,
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionStore>()
const compressionQueue = new Set<string>() // sessionIds to compress

// ─── Summary Generation ───────────────────────────────────────────────────────

const llmClient: LLMClient | null = createLLMClient(config.llm)
const summaryIndex = new SummaryIndex(resolve(process.cwd(), "data/summaries.db"))
const summaryQueue: Array<{ sessionId: string; turnIndex: number }> = []
const MAX_SUMMARY_RETRIES = 2

// Run summary worker on a recurring interval so new queue items are always picked up
setInterval(() => {
  runSummaryWorker().catch((err) =>
    console.error("[summary] worker fatal:", err),
  )
}, 1_000)

// Run compression worker on a recurring interval
setInterval(() => {
  runWorker()
}, 2_000)

async function runSummaryWorker(): Promise<void> {
  if (!llmClient) return
  if (summaryQueue.length === 0) return

  while (summaryQueue.length > 0) {
    const task = summaryQueue.shift()!
    const store = sessions.get(task.sessionId)
    if (!store) continue

    const turn = store.turns.find((t) => t.index === task.turnIndex && !t.isCurrent)
    if (!turn) continue
    if (turn.summary) continue

    try {
      const result = await llmClient.generateSummary(task.turnIndex, turn.messages)
      turn.summary = result.summary

      // Persist to FTS5 index
      summaryIndex.insert(result.summary, task.sessionId)

      console.log(
        `[summary] turn=${task.turnIndex} session=${task.sessionId.slice(0, 8)}.. ` +
        `outcome=${result.summary.outcome} confidence=${result.summary.confidence} ` +
        `tokens=${result.tokensUsed}`,
      )
    } catch (err) {
      console.error(`[summary] failed turn=${task.turnIndex}:`, err)
      // Re-queue with retry cap
      const retries = (turn as any)._summaryRetries ?? 0
      if (retries < MAX_SUMMARY_RETRIES) {
        ;(turn as any)._summaryRetries = retries + 1
        summaryQueue.push(task)
      }
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function estimateTokens(messages: any[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + (JSON.stringify(m).length / 4), 0)
  )
}

function getRole(msg: any): string {
  return msg?.info?.role || msg?.role || ""
}

function hashArray(messages: any[], bucketSize: number): BucketHashes {
  const buckets: Record<number, string> = {}
  for (let i = 0; i < messages.length; i += bucketSize) {
    const bucket = messages.slice(i, i + bucketSize)
    const content = JSON.stringify(bucket)
    buckets[i / bucketSize] = createHash("sha256").update(content).digest("hex")
  }
  return buckets
}

/**
 * Split source messages into turns.
 * A turn ends when the NEXT message is a user message.
 * The last segment is always marked as "current".
 *
 * Example:
 *   [sys, user, asst, user, asst, user, asst]
 *   → Turn 0: [sys, user, asst]       (completed, next is user)
 *   → Turn 1: [user, asst]           (completed, next is user)
 *   → Turn 2: [user, asst]           (current, no next user)
 */
function splitIntoTurns(messages: any[]): Turn[] {
  if (messages.length === 0) return []

  const turns: Turn[] = []
  let currentTurnStart = 0

  for (let i = 1; i < messages.length; i++) {
    const prevMsg = messages[i - 1]
    const currMsg = messages[i]
    const prevRole = getRole(prevMsg)
    const currRole = getRole(currMsg)

    if (prevRole !== "user" && currRole === "user") {
      const turnMessages = messages.slice(currentTurnStart, i)
      turns.push({
        index: turns.length,
        startIdx: currentTurnStart,
        endIdx: i,
        messages: turnMessages,
        isCurrent: false,
        messageCount: turnMessages.length,
        tokenEstimate: estimateTokens(turnMessages),
        compressedMessages: [],
      })
      currentTurnStart = i
    }
  }

  const finalMessages = messages.slice(currentTurnStart)
  turns.push({
    index: turns.length,
    startIdx: currentTurnStart,
    endIdx: messages.length,
    messages: finalMessages,
    isCurrent: true,
    messageCount: finalMessages.length,
    tokenEstimate: estimateTokens(finalMessages),
    compressedMessages: [],
  })

  return turns
}

// ─── Compression helpers ───────────────────────────────────────────────────────

const CACHEABLE_TOOLS: Set<string> = new Set([
  "read", "glob", "grep", "webfetch",
])

function getToolOutputKey(toolName: string, state: any): string | null {
  const input = state?.input || {}
  const tool = toolName.toLowerCase()

  switch (tool) {
    case "read": {
      const filePath = input.filePath || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "filePath" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `file:${filePath};${params}` : `file:${filePath}`
    }
    case "grep": {
      const pattern = input.pattern || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "pattern" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `grep:${pattern};${params}` : `grep:${pattern}`
    }
    case "glob": {
      const pattern = input.pattern || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "pattern" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `glob:${pattern};${params}` : `glob:${pattern}`
    }
    case "webfetch": {
      const url = input.url || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "url" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `url:${url};${params}` : `url:${url}`
    }
    default:
      return null
  }
}

type DecayContext = {
  currentTurnIdx: number
  now: number
}

function calculateDecayScore(
  entry: ToolOutputEntry,
  ctx: DecayContext
): number {
  const { distance: wDist, time: wTime, frequency: wFreq } = DECAY_WEIGHTS

  const turnDistance = ctx.currentTurnIdx - Math.floor(entry.lastCallIdx / 10)
  const distanceScore = Math.min(turnDistance / 3, 5)

  const timeAgeMinutes = (ctx.now - entry.lastCallTime) / 60000
  const timeScore = Math.log2(timeAgeMinutes + 1) * wTime

  const frequencyScore = Math.log2(entry.callCount + 1) * wFreq

  const toolModifier = TOOL_DECAY_MODIFIERS[entry.toolType] || 1.0

  const baseScore = distanceScore * wDist + timeScore - frequencyScore
  return Math.max(0, Math.min(baseScore * toolModifier, 10))
}

function getCompressionLevel(
  entry: ToolOutputEntry,
  ctx: DecayContext
): CompressionLevel {
  const score = calculateDecayScore(entry, ctx)
  if (score < 2) return "full"
  if (score < 5) return "summary"
  if (score < 8) return "placeholder"
  return "minimal"
}

function compressToolOutput(toolName: string, state: any, level: CompressionLevel): string {
  const input = state?.input || {}
  const output = state?.output || ""
  const tool = toolName.toLowerCase()

  switch (tool) {
    case "read": {
      const filePath = input.filePath || input.file || input.path || "?"
      const lines = output.split("\n")
      const lineCount = lines.length
      switch (level) {
        case "full": return output
        case "summary": {
          const preview = [
            ...lines.slice(0, 3),
            `  ... ${Math.max(0, lineCount - 6)} more lines ...`,
            ...lines.slice(-3),
          ].join("\n")
          return `[COMPRESSED: read "${filePath}"]\n${preview}`
        }
        case "placeholder":
          return `[COMPRESSED: read "${filePath}" — ${lineCount} lines]`
        default:
          return `[COMPRESSED: read "${filePath}"]`
      }
    }
    case "glob": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: glob "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(", ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder":
          return `[COMPRESSED: glob "${pattern}" — ${count} matches]`
        default:
          return `[COMPRESSED: glob "${pattern}"]`
      }
    }
    case "grep": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: grep "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(" | ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder":
          return `[COMPRESSED: grep "${pattern}" — ${count} matches]`
        default:
          return `[COMPRESSED: grep "${pattern}"]`
      }
    }
    case "webfetch": {
      const url = input.url || "?"
      const size = new TextEncoder().encode(output).length
      switch (level) {
        case "full": return output
        case "summary": return `[COMPRESSED: webfetch "${url}"]\n${output.slice(0, 200)}...`
        case "placeholder": return `[COMPRESSED: webfetch "${url}" — ${size} bytes]`
        default: return `[COMPRESSED: webfetch "${url}"]`
      }
    }
    default:
      return `[COMPRESSED: ${toolName} — output truncated]`
  }
}

function buildCompressedFromTurn(
  turnMessages: any[],
  startGlobalIdx: number,
  toolOutputs: Map<string, ToolOutputEntry>,
  ctx: DecayContext,
): any[] {
  const result: any[] = []

  // Single forward pass: deduplicate + apply decay compression.
  // Earlier duplicates are skipped; the latest occurrence is kept.
  for (let i = 0; i < turnMessages.length; i++) {
    const msg = turnMessages[i]
    const role = getRole(msg)
    if (role !== "assistant") {
      result.push(structuredClone(msg))
      continue
    }

    const cloned = structuredClone(msg)

    for (let pi = 0; pi < (cloned.parts || []).length; pi++) {
      const part = cloned.parts[pi]
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName: string = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue

      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue

      if (toolOutputs.has(key)) {
        const entry = toolOutputs.get(key)!
        const globalIdx = startGlobalIdx + i
        const entryForScore: ToolOutputEntry = {
          ...entry,
          lastCallIdx: globalIdx,
          lastCallTime: entry.lastCallTime,
        }
        const level = getCompressionLevel(entryForScore, ctx)
        if (level !== "full") {
          part.state.output = compressToolOutput(toolName, part.state, level)
        }
      }
    }

    result.push(cloned)
  }

  return result
}

// ─── Core: Compress a completed turn ─────────────────────────────────────────

/**
 * Compress a completed turn by applying dedup + decay.
 * Hot turns (within MAX_HOT_TURNS) keep full output for recent tool calls.
 * Cold turns (older than MAX_HOT_TURNS) get full compression applied.
 */
function compressTurn(
  turn: Turn,
  turnIndex: number,
  toolOutputs: Map<string, ToolOutputEntry>,
  now: number,
): any[] {
  const ctx: DecayContext = { currentTurnIdx: turnIndex, now }
  return buildCompressedFromTurn(turn.messages, turn.startIdx, toolOutputs, ctx)
}

// ─── Background worker ────────────────────────────────────────────────────────

let isWorkerRunning = false

function evictStaleToolOutputs(toolOutputs: Map<string, ToolOutputEntry>, maxEntries: number): void {
  if (toolOutputs.size <= maxEntries) return
  const entries = [...toolOutputs.entries()]
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
  const toRemove = entries.slice(0, toolOutputs.size - maxEntries)
  for (const [key] of toRemove) {
    toolOutputs.delete(key)
  }
}

async function runWorker(): Promise<void> {
  if (isWorkerRunning) return
  if (compressionQueue.size === 0) return
  isWorkerRunning = true
  try {
    for (const sessionId of compressionQueue) {
      const store = sessions.get(sessionId)
      if (!store) {
        compressionQueue.delete(sessionId)
        continue
      }

      const now = Date.now()
      const completedTurns = store.turns.filter((t) => !t.isCurrent)

      for (let i = 0; i < completedTurns.length; i++) {
        const turn = completedTurns[i]
        if (turn.compressedMessages.length > 0) continue

        const isHot = i >= completedTurns.length - MAX_HOT_TURNS
        turn.compressedMessages = isHot
          ? structuredClone(turn.messages)
          : compressTurn(turn, turn.index, store.toolOutputs, now)
      }

      // Rebuild compressed view
      const compressedAll: any[] = []
      for (const turn of completedTurns) {
        compressedAll.push(...turn.compressedMessages)
      }
      const currentTurn = store.turns.find((t) => t.isCurrent)
      if (currentTurn) {
        compressedAll.push(...currentTurn.messages)
      }

      store.compressedBucketHashes = hashArray(compressedAll, BUCKET_SIZE)

      // Evict oldest tool output entries if map is too large
      evictStaleToolOutputs(store.toolOutputs, MAX_TOOL_OUTPUTS_PER_SESSION)

      compressionQueue.delete(sessionId)
    }
  } finally {
    isWorkerRunning = false
  }
}

function queueCompression(sessionId: string): void {
  compressionQueue.add(sessionId)
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/sync", (req: Request, res: Response) => {
  const { sessionId, clientBucketHashes, changedBuckets, completedTurnCount, currentTurnIndex } = req.body

  if (!sessionId || typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return res.status(400).json({ error: "invalid sessionId format" })
  }

  let store = sessions.get(sessionId)

  if (!store) {
    // First sync: build turns from changed buckets
    const allMessages: any[] = []
    if (Array.isArray(changedBuckets)) {
      for (const bucket of changedBuckets) {
        if (Array.isArray(bucket.messages)) {
          allMessages.push(...bucket.messages)
        }
      }
    }

    const turns = splitIntoTurns(allMessages)
    const completedTurns = turns.filter((t) => !t.isCurrent)

    store = {
      source: allMessages,
      turns,
      lastKnownTurnCount: completedTurnCount ?? completedTurns.length,
      compressedBucketHashes: {},
      toolOutputs: new Map(),
      createdAt: Date.now(),
      summaryIndex,
    }

    // Queue summaries for all completed turns
    for (const turn of completedTurns) {
      summaryQueue.push({ sessionId, turnIndex: turn.index })
    }
    console.log(`[sync] queued ${completedTurns.length} summaries`)

    // Mark all completed turns for compression
    queueCompression(sessionId)

    sessions.set(sessionId, store)

    // Return current state
    return res.json({
      turns: turns.map((t) => ({
        index: t.index,
        messages: t.isCurrent ? t.messages : (t.compressedMessages.length > 0 ? t.compressedMessages : t.messages),
        isCurrent: t.isCurrent,
      })),
      currentTurnIndex: currentTurnIndex ?? (turns.length - 1),
      serverBucketHashes: store.compressedBucketHashes,
    })
  }

  // Merge new messages
  if (Array.isArray(changedBuckets) && changedBuckets.length > 0) {
    const newMessages: any[] = []
    for (const bucket of changedBuckets) {
      if (Array.isArray(bucket.messages)) {
        newMessages.push(...bucket.messages)
      }
    }

      if (newMessages.length > 0) {
      const prevLen = store.source.length
      store.source = [...store.source, ...newMessages]
      const prevTurnCount = store.turns.filter((t) => !t.isCurrent).length
      store.turns = splitIntoTurns(store.source)
      store.lastKnownTurnCount = completedTurnCount ?? store.turns.filter((t) => !t.isCurrent).length

      // Queue summaries for newly completed turns
      const newCompletedTurns = store.turns.filter(
        (t) => !t.isCurrent && t.index >= prevTurnCount,
      )
      for (const turn of newCompletedTurns) {
        summaryQueue.push({ sessionId, turnIndex: turn.index })
      }

      queueCompression(sessionId)
    }
  }

  const completedTurns = store.turns.filter((t) => !t.isCurrent)
  const currentTurn = store.turns.find((t) => t.isCurrent)

  return res.json({
    turns: store.turns.map((t) => ({
      index: t.index,
      messages: t.isCurrent ? t.messages : (t.compressedMessages.length > 0 ? t.compressedMessages : t.messages),
      isCurrent: t.isCurrent,
    })),
    currentTurnIndex: currentTurn?.index ?? completedTurns.length,
    serverBucketHashes: store.compressedBucketHashes,
  })
})

app.get("/turns/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  return res.json({
    turns: store.turns.map((t) => ({
      index: t.index,
      startIdx: t.startIdx,
      endIdx: t.endIdx,
      messageCount: t.messageCount,
      tokenEstimate: t.tokenEstimate,
      isCurrent: t.isCurrent,
      isCompressed: t.compressedMessages.length > 0,
      isHot: !t.isCurrent && t.index >= store.turns.filter((x) => !x.isCurrent).length - MAX_HOT_TURNS,
      hasSummary: !!t.summary,
      outcome: t.summary?.outcome,
      confidence: t.summary?.confidence,
    })),
    lastKnownTurnCount: store.lastKnownTurnCount,
    sourceLength: store.source.length,
  })
})

app.get("/turns/:sessionId/summary/:turnIndex", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  const turnIdx = req.params.turnIndex as string
  const store = sessions.get(sid)
  if (!store) return res.status(404).json({ error: "session not found" })

  const turn = store.turns.find(
    (t) => t.index === parseInt(String(turnIdx), 10),
  )
  if (!turn) return res.status(404).json({ error: "turn not found" })

  if (turn.summary) {
    return res.json({ summary: turn.summary, source: "memory" })
  }

  const indexed = store.summaryIndex.get(sid, parseInt(String(turnIdx), 10))
  if (indexed) {
    return res.json({ summary: indexed, source: "index" })
  }

  return res.status(404).json({ error: "summary not yet available" })
})

app.get("/turns/:sessionId/search", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  const store = sessions.get(sid)
  if (!store) return res.status(404).json({ error: "session not found" })

  const rawQ = req.query.q
  const query = typeof rawQ === "string" ? rawQ : ""
  const rawLimit = req.query.limit
  const limit = Math.min(typeof rawLimit === "string" ? parseInt(rawLimit, 10) : 10, 50)

  const results = store.summaryIndex.search(sid, query, limit)

  const withFresh = results.map((r) => {
    const turn = store.turns.find((t) => t.index === r.turnIndex)
    return turn?.summary || r
  })

  return res.json({ query, results: withFresh, count: withFresh.length })
})

app.post("/turns/:sessionId/archive", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  // Archive the oldest turn (move from hot to cold)
  const completedTurns = store.turns.filter((t) => !t.isCurrent)
  if (completedTurns.length > MAX_HOT_TURNS) {
    const oldestCompleted = completedTurns[0]
    const now = Date.now()
    oldestCompleted.compressedMessages = compressTurn(oldestCompleted, oldestCompleted.index, store.toolOutputs, now)
    queueCompression(req.params.sessionId as string)
  }

  return res.json({ ok: true, hotTurns: completedTurns.length - MAX_HOT_TURNS })
})

app.get("/state/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })
  return res.json({
    sourceLength: store.source.length,
    turnCount: store.turns.length,
    completedTurnCount: store.turns.filter((t) => !t.isCurrent).length,
    hotTurns: store.turns.filter((t) => !t.isCurrent && t.index >= store.turns.filter((x) => !x.isCurrent).length - MAX_HOT_TURNS).length,
    compressedBucketHashes: store.compressedBucketHashes,
  })
})

app.get("/stats/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  let compressedCount = 0, fullCount = 0
  const byTool: Record<string, number> = {}
  for (const [, entry] of store.toolOutputs) {
    if (entry.compressed) compressedCount++; else fullCount++
  }

  return res.json({
    sourceLength: store.source.length,
    turnCount: store.turns.length,
    completedTurnCount: store.turns.filter((t) => !t.isCurrent).length,
    totalToolOutputs: store.toolOutputs.size,
    fullOutputs: fullCount,
    compressedOutputs: compressedCount,
    byTool,
    pendingCompression: compressionQueue.has(req.params.sessionId as string),
  })
})

app.delete("/session/:sessionId", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  if (!SESSION_ID_PATTERN.test(sid)) {
    return res.status(400).json({ error: "invalid sessionId format" })
  }
  sessions.delete(sid)
  compressionQueue.delete(sid)
  summaryIndex.deleteSession(sid)
  // Remove orphaned summaryQueue entries for this session
  for (let i = summaryQueue.length - 1; i >= 0; i--) {
    if (summaryQueue[i].sessionId === sid) {
      summaryQueue.splice(i, 1)
    }
  }
  return res.json({ ok: true })
})

// ─── Housekeeping ─────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  const TTL = server.sessionTtlMs
  let evicted = 0
  for (const [id, store] of sessions) {
    if (now - store.createdAt > TTL) {
      sessions.delete(id)
      compressionQueue.delete(id)
      summaryIndex.deleteSession(id)
      // Remove orphaned summaryQueue entries
      for (let i = summaryQueue.length - 1; i >= 0; i--) {
        if (summaryQueue[i].sessionId === id) {
          summaryQueue.splice(i, 1)
        }
      }
      evicted++
    }
  }
  if (evicted > 0) {
    console.log(`[${new Date().toISOString()}] Sessions: ${sessions.size}, evicted: ${evicted}`)
  }
}, 5 * 60 * 1000)

// ─── Startup ──────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    sessions: sessions.size,
    pending: compressionQueue.size,
    maxHotTurns: MAX_HOT_TURNS,
  })
})

const PORT = server.port
app.listen(PORT, () => {
  console.log(`Transform server listening on http://localhost:${PORT}`)
  console.log(`Paging: Page = Turn, max_hot_turns = ${MAX_HOT_TURNS}`)
})
