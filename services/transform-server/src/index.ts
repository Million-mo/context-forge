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

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

type ToolOutputEntry = {
  key: string
  toolType: string
  output: string
  timestamp: number
  lastSeenTurnIdx: number
  callCount: number
}

interface Turn {
  index: number
  startIdx: number
  endIdx: number
  messages: any[]
  isCurrent: boolean
  messageCount: number
  tokenEstimate: number

  /** SHA-256 of the raw messages array (without any summary/compression fields) */
  contentHash: string

  /** Summary state */
  summaryStatus: "pending" | "generating" | "done" | "unavailable"
  summary?: TurnSummary
}

type SessionStore = {
  /** All messages in order (source of truth) */
  source: any[]
  /** Per-turn breakdown */
  turns: Turn[]
  /** Global tool output cache for dedup + decay */
  toolOutputs: Map<string, ToolOutputEntry>
  /** Summary index (FTS5, persisted) */
  summaryIndex: SummaryIndex
  createdAt: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

const { server } = config
const MAX_HOT_TURNS = server.maxHotTurns
const TOKEN_BUDGET = server.tokenBudget
const DECAY_WEIGHTS = server.decayWeights

const TOOL_DECAY_MODIFIERS: Record<string, number> = {
  read: 0.8,
  glob: 0.6,
  grep: 0.7,
  webfetch: 1.5,
}

const CACHEABLE_TOOLS: Set<string> = new Set([
  "read", "glob", "grep", "webfetch",
])

// ─── Storage ────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionStore>()

// ─── Summary Generation (Async, Cached) ────────────────────────────────────────

const llmClient: LLMClient | null = createLLMClient(config.llm)
const summaryIndex = new SummaryIndex(resolve(process.cwd(), "data/summaries.db"))

// Queue for turns that need summary generation (by content hash)
type SummaryTask = {
  sessionId: string
  turnIndex: number
  contentHash: string
  messages: any[]
  createdAt: number
}
const summaryQueue: SummaryTask[] = []
const MAX_QUEUE_SIZE = 1000
const MAX_TASK_AGE_MS = 30 * 60 * 1000 // 30 minutes

setInterval(() => {
  runSummaryWorker().catch((err) =>
    console.error("[summary] worker fatal:", err),
  )
}, 1_000)

/**
 * Add task to queue with deduplication.
 */
function enqueueSummaryTask(task: Omit<SummaryTask, "createdAt">): boolean {
  // Check queue size limit
  if (summaryQueue.length >= MAX_QUEUE_SIZE) {
    console.warn(`[summary] queue full (${MAX_QUEUE_SIZE}), dropping oldest`)
    summaryQueue.shift()
  }

  // Deduplicate by contentHash
  if (summaryQueue.some((t) => t.contentHash === task.contentHash)) {
    return false // Already queued
  }

  summaryQueue.push({ ...task, createdAt: Date.now() })
  return true
}

/**
 * Clean up stale tasks periodically.
 */
setInterval(() => {
  const now = Date.now()
  const before = summaryQueue.length
  // Remove tasks older than MAX_TASK_AGE_MS
  const filtered = summaryQueue.filter((t) => now - t.createdAt < MAX_TASK_AGE_MS)
  summaryQueue.length = 0
  summaryQueue.push(...filtered)

  if (summaryQueue.length < before) {
    console.log(`[summary] cleaned ${before - summaryQueue.length} stale tasks`)
  }
}, 5 * 60 * 1000) // Every 5 minutes

async function runSummaryWorker(): Promise<void> {
  if (!llmClient) return
  if (summaryQueue.length === 0) return

  while (summaryQueue.length > 0) {
    const task = summaryQueue.shift()!

    try {
      const result = await llmClient.generateSummary(task.turnIndex, task.messages)

      // Save to global cache (by content hash)
      summaryIndex.insert(result.summary, task.sessionId, task.contentHash)

      // Update in-memory state for all sessions that have this turn
      for (const [sid, store] of sessions) {
        const turn = store.turns.find((t) => t.index === task.turnIndex && !t.isCurrent)
        if (turn && turn.contentHash === task.contentHash) {
          turn.summary = result.summary
          turn.summaryStatus = "done"
        }
      }

      console.log(
        `[summary] turn=${task.turnIndex} hash=${task.contentHash.slice(0, 8)}.. ` +
        `outcome=${result.summary.outcome} confidence=${result.summary.confidence} ` +
        `tokens=${result.tokensUsed}`,
      )
    } catch (err) {
      console.error(`[summary] failed turn=${task.turnIndex} hash=${task.contentHash.slice(0, 8)}..:`, err)
    }
  }
}

/**
 * Lookup summary by content hash (fast path).
 */
function getCachedSummary(contentHash: string): TurnSummary | null {
  return summaryIndex.getByHash(contentHash)
}

/**
 * Trigger async summary generation for a turn.
 */
function triggerSummaryGeneration(sessionId: string, turn: Turn): void {
  if (turn.summaryStatus !== "pending") return
  if (turn.isCurrent) return // Don't generate for current turn

  const queued = enqueueSummaryTask({
    sessionId,
    turnIndex: turn.index,
    contentHash: turn.contentHash,
    messages: turn.messages,
  })

  if (queued) {
    turn.summaryStatus = "generating"
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function estimateTokens(messages: any[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + (JSON.stringify(m).length / 4), 0)
  )
}

function getRole(msg: any): string {
  return msg?.info?.role || msg?.role || ""
}

function hashMessages(messages: any[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex")
}

/**
 * Split source messages into turns.
 * A turn ends when the NEXT message is a user message.
 * The last segment is always marked as "current".
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
        contentHash: hashMessages(turnMessages),
        summaryStatus: "pending",
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
    contentHash: hashMessages(finalMessages),
    summaryStatus: "pending",
  })

  return turns
}

// ─── Tool Output Dedup & Decay ───────────────────────────────────────────────

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

function calculateDecayScore(entry: ToolOutputEntry, ctx: DecayContext): number {
  const { distance: wDist, time: wTime, frequency: wFreq } = DECAY_WEIGHTS

  const turnDistance = ctx.currentTurnIdx - Math.floor(entry.lastSeenTurnIdx / 10)
  const distanceScore = Math.min(turnDistance / 3, 5)

  const timeAgeMinutes = (ctx.now - entry.timestamp) / 60000
  const timeScore = Math.log2(timeAgeMinutes + 1) * wTime

  const frequencyScore = Math.log2(entry.callCount + 1) * wFreq

  const toolModifier = TOOL_DECAY_MODIFIERS[entry.toolType] || 1.0

  const baseScore = distanceScore * wDist + timeScore - frequencyScore
  return Math.max(0, Math.min(baseScore * toolModifier, 10))
}

function getCompressionLevel(score: number): CompressionLevel {
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

/**
 * Update tool output dedup index from the latest messages.
 * Updates lastSeenTurnIdx, callCount, and timestamp.
 * Does NOT compress — just maintains the index for decay scoring.
 */
function updateToolOutputIndex(
  turns: Turn[],
  toolOutputs: Map<string, ToolOutputEntry>,
  currentTurnIdx: number,
): void {
  for (const turn of turns) {
    for (let i = 0; i < turn.messages.length; i++) {
      const msg = turn.messages[i]
      if (getRole(msg) !== "assistant") continue

      for (const part of msg.parts || []) {
        if (part.type !== "tool" || part.state?.status !== "completed") continue
        const toolName: string = part.tool || ""
        if (!CACHEABLE_TOOLS.has(toolName)) continue

        const key = getToolOutputKey(toolName, part.state)
        if (!key) continue

        const output = part.state.output || ""

        if (toolOutputs.has(key)) {
          const entry = toolOutputs.get(key)!
          entry.lastSeenTurnIdx = turn.index
          entry.callCount++
          // Update output if the same key now has different content
          if (entry.output !== output) {
            entry.output = output
          }
        } else {
          toolOutputs.set(key, {
            key,
            toolType: toolName,
            output,
            timestamp: Date.now(),
            lastSeenTurnIdx: turn.index,
            callCount: 1,
          })
        }
      }
    }
  }
}

/**
 * Build compressed messages for a hot turn (within MAX_HOT_TURNS).
 * Applies decay-based compression on tool outputs, but keeps the full structure.
 */
function buildCompressedMessagesForHotTurn(
  turn: Turn,
  toolOutputs: Map<string, ToolOutputEntry>,
  currentTurnIdx: number,
): any[] {
  const now = Date.now()
  const result: any[] = []

  for (const msg of turn.messages) {
    const role = getRole(msg)
    if (role !== "assistant") {
      result.push(structuredClone(msg))
      continue
    }

    const cloned = structuredClone(msg)

    for (const part of cloned.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName: string = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue

      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue

      const entry = toolOutputs.get(key)
      if (!entry) continue

      const score = calculateDecayScore(entry, { currentTurnIdx, now })
      const level = getCompressionLevel(score)
      if (level !== "full") {
        part.state.output = compressToolOutput(toolName, part.state, level)
      }
    }

    result.push(cloned)
  }

  return result
}

// ─── Cold Zone Replacement ──────────────────────────────────────────────────

/**
 * Build a summary message pair for a cold turn:
 * - user message: describes the turn context
 * - assistant message: contains the actual summary content
 */
function buildSummaryReplacement(turn: Turn): any[] {
  const s = turn.summary
  const timestamp = new Date(turn.messages[0]?.timestamp ?? Date.now()).toLocaleString()

  const userMsg: any = {
    role: "user",
    info: { role: "user", __compressed: "summary", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: `=== Turn ${turn.index} Summary (${timestamp}) ===\nThis turn has been compressed. Original: ${turn.messageCount} messages, ~${turn.tokenEstimate} tokens.`,
    }],
  }

  const assistantMsg: any = {
    role: "assistant",
    info: { role: "assistant", __compressed: "summary", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: s
        ? [
          `Turn ${turn.index} Summary:`,
          `Overview: ${s.overview}`,
          s.intent ? `Intent: ${s.intent}` : null,
          s.actions.length > 0 ? `Actions: ${s.actions.map((a) => `${a.tool}(${a.target})`).join(", ")}` : null,
          s.artifacts.length > 0 ? `Artifacts: ${s.artifacts.map((a) => `${a.action} ${a.path}`).join(", ")}` : null,
          `Outcome: ${s.outcome}`,
        ].filter(Boolean).join("\n")
        : `(Summary not yet generated for this turn)`,
    }],
  }

  return [userMsg, assistantMsg]
}

// ─── Token Budget ────────────────────────────────────────────────────────────

/**
 * Build a placeholder message for a turn without summary.
 */
function buildPlaceholderReplacement(turn: Turn): any[] {
  return [{
    role: "user",
    info: { role: "user", __compressed: "placeholder", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: `=== Turn ${turn.index} (${turn.messageCount} messages, ~${turn.tokenEstimate} tokens) ===\n[Compressed]`,
    }],
  }]
}

/**
 * Build the final message array with progressive compression.
 *
 * Correct order:
 * 1. Reserve space for current turn
 * 2. Process turns from newest to oldest, keeping as many as possible with decay
 * 3. For older turns that don't fit, replace with summary or placeholder
 * 4. Current turn is always included at the end
 *
 * @param turns - Pre-processed turns (tool dedup already applied to messages)
 * @param toolOutputs - Tool output cache for decay scoring
 * @param budget - Target token budget
 * @returns Compressed message array
 */
function buildCompressedMessages(
  turns: Turn[],
  toolOutputs: Map<string, ToolOutputEntry>,
  budget: number,
): any[] {
  const completedTurns = turns.filter((t) => !t.isCurrent)
  const currentTurn = turns.find((t) => t.isCurrent)

  // Reserve space for current turn
  const reservedForCurrent = currentTurn ? estimateTokens(currentTurn.messages) : 0
  const availableBudget = budget - reservedForCurrent

  if (availableBudget <= 0) {
    // Not enough space even for current turn
    return currentTurn ? [...currentTurn.messages] : []
  }

  // Process turns from newest to oldest, keeping as many as possible
  const keptMessages: any[] = []
  const replacedTurns: Turn[] = []
  let usedTokens = 0

  // Reverse iteration: newest first
  for (const turn of [...completedTurns].reverse()) {
    const compressed = buildCompressedMessagesForHotTurn(turn, toolOutputs, turns.length)
    const tokens = estimateTokens(compressed)

    if (usedTokens + tokens <= availableBudget) {
      // Can fit - keep this turn (prepend to result later)
      keptMessages.unshift(...compressed)
      usedTokens += tokens
    } else {
      // Can't fit - mark for replacement
      replacedTurns.unshift(turn)
    }
  }

  // Now replace old turns with summaries from front (oldest) to back
  const result: any[] = []
  for (const turn of replacedTurns) {
    if (turn.summaryStatus === "done" && turn.summary) {
      result.push(...buildSummaryReplacement(turn))
    } else {
      result.push(...buildPlaceholderReplacement(turn))
    }
  }

  // Add kept messages (recent turns with decay)
  result.push(...keptMessages)

  // Add current turn at the end
  if (currentTurn) {
    result.push(...currentTurn.messages)
  }

  return result
}

// ─── Session Sync ─────────────────────────────────────────────────────────────

/**
 * Sync session with hash-based caching:
 * 1. Update tool dedup index
 * 2. Split into turns
 * 3. For each completed turn: compute hash → lookup cache → trigger async generation if needed
 * 4. Build compressed messages respecting token budget
 */
function syncSession(sessionId: string, messages: any[], store: SessionStore): any[] {
  const prevTurnCount = store.turns.length

  // Step 1: Update tool output dedup index BEFORE splitting turns
  store.source = messages
  updateToolOutputIndexFromMessages(messages, store.toolOutputs)

  // Step 2: Split into turns
  store.turns = splitIntoTurns(messages)

  // Step 3: For each completed turn, lookup cache or trigger async generation
  const completedTurns = store.turns.filter((t) => !t.isCurrent)
  const pendingSummaries: Turn[] = []

  for (const turn of completedTurns) {
    // Skip if already processed
    if (turn.summaryStatus === "done" || turn.summaryStatus === "generating") {
      continue
    }

    // Try to get from cache (fast path)
    const cachedSummary = getCachedSummary(turn.contentHash)
    if (cachedSummary) {
      turn.summary = cachedSummary
      turn.summaryStatus = "done"
      console.log(`[cache] hit turn=${turn.index} hash=${turn.contentHash.slice(0, 8)}..`)
    } else if (turn.summaryStatus === "pending") {
      // Need to generate
      pendingSummaries.push(turn)
    }
  }

  // Trigger async generation for pending turns (only for new turns)
  // New turns have index >= prevTurnCount (the count before this sync)
  for (const turn of pendingSummaries) {
    if (turn.index >= prevTurnCount) {
      triggerSummaryGeneration(sessionId, turn)
    }
  }

  // Step 4: Build compressed messages
  return buildCompressedMessages(store.turns, store.toolOutputs, TOKEN_BUDGET)
}

/**
 * Update tool output dedup index from a flat message list.
 * This runs BEFORE turn splitting to establish the global tool state.
 */
function updateToolOutputIndexFromMessages(
  messages: any[],
  toolOutputs: Map<string, ToolOutputEntry>,
): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (getRole(msg) !== "assistant") continue

    for (const part of msg.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName: string = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue

      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue

      const output = part.state.output || ""

      if (toolOutputs.has(key)) {
        const entry = toolOutputs.get(key)!
        entry.lastSeenTurnIdx = Math.floor(i / 10) // Approximate turn index
        entry.callCount++
        if (entry.output !== output) {
          entry.output = output
        }
      } else {
        toolOutputs.set(key, {
          key,
          toolType: toolName,
          output,
          timestamp: Date.now(),
          lastSeenTurnIdx: Math.floor(i / 10),
          callCount: 1,
        })
      }
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.post("/sync", (req: Request, res: Response) => {
  const { sessionId, messages } = req.body

  if (!sessionId || typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    return res.status(400).json({ error: "invalid sessionId format" })
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" })
  }

  let store = sessions.get(sessionId)

  if (!store) {
    const toolOutputs = new Map<string, ToolOutputEntry>()
    // Step 1: Process tool dedup BEFORE splitting turns
    updateToolOutputIndexFromMessages(messages, toolOutputs)

    const turns = splitIntoTurns(messages)

    // Step 2: For each completed turn, lookup cache or mark for async generation
    const completedTurns = turns.filter((t) => !t.isCurrent)
    for (const turn of completedTurns) {
      const cachedSummary = getCachedSummary(turn.contentHash)
      if (cachedSummary) {
        turn.summary = cachedSummary
        turn.summaryStatus = "done"
      } else if (turn.summaryStatus === "pending") {
        // Mark for async generation
        triggerSummaryGeneration(sessionId, turn)
      }
    }

    store = {
      source: messages,
      turns,
      toolOutputs,
      summaryIndex,
      createdAt: Date.now(),
    }
    sessions.set(sessionId, store)

    const compressed = buildCompressedMessages(store.turns, store.toolOutputs, TOKEN_BUDGET)
    console.log(`[sync] new session ${sessionId.slice(0, 8)}.. ${store.turns.length} turns, ${compressed.length} msgs returned`)
    return res.json({ messages: compressed })
  }

  const compressed = syncSession(sessionId, messages, store)
  return res.json({ messages: compressed })
})

app.get("/turns/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  const completedTurns = store.turns.filter((t) => !t.isCurrent)
  const totalTokens = completedTurns.reduce((sum, t) => sum + t.tokenEstimate, 0)
  const currentTurn = store.turns.find((t) => t.isCurrent)
  const reservedTokens = currentTurn ? estimateTokens(currentTurn.messages) : 0

  // Dynamically calculate which turns would be replaced based on token budget
  let cumulativeTokens = reservedTokens
  const replacedIndices = new Set<number>()
  for (const turn of [...completedTurns].reverse()) {
    cumulativeTokens += turn.tokenEstimate
    if (cumulativeTokens > TOKEN_BUDGET) {
      replacedIndices.add(turn.index)
    }
  }

  return res.json({
    turns: store.turns.map((t) => ({
      index: t.index,
      startIdx: t.startIdx,
      endIdx: t.endIdx,
      messageCount: t.messageCount,
      tokenEstimate: t.tokenEstimate,
      isCurrent: t.isCurrent,
      isReplaced: replacedIndices.has(t.index),
      summaryStatus: t.summaryStatus,
      hasSummary: t.summaryStatus === "done",
      outcome: t.summary?.outcome,
      confidence: t.summary?.confidence,
      contentHash: t.contentHash,
    })),
    sourceLength: store.source.length,
    totalTokens,
    reservedTokens,
    tokenBudget: TOKEN_BUDGET,
  })
})

app.get("/turns/:sessionId/summary/:turnIndex", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  const turnIdx = parseInt(req.params.turnIndex as string, 10)
  const store = sessions.get(sid)
  if (!store) return res.status(404).json({ error: "session not found" })

  const turn = store.turns.find((t) => t.index === turnIdx)
  if (!turn) return res.status(404).json({ error: "turn not found" })

  if (turn.summary) return res.json({ summary: turn.summary, source: "memory" })

  // Try to get from global cache by hash
  const indexed = summaryIndex.getByHash(turn.contentHash)
  if (indexed) return res.json({ summary: indexed, source: "cache" })

  return res.status(404).json({ error: "summary not yet available" })
})

app.get("/search/:sessionId", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  if (!SESSION_ID_PATTERN.test(sid)) return res.status(400).json({ error: "invalid sessionId" })

  const store = sessions.get(sid)
  if (!store) return res.status(404).json({ error: "session not found" })

  const rawQ = req.query.q
  const query = typeof rawQ === "string" ? rawQ : ""
  const rawLimit = req.query.limit
  const limit = Math.min(typeof rawLimit === "string" ? parseInt(rawLimit, 10) : 5, 20)

  // Global search across all cached summaries
  const summaryResults = summaryIndex.search(query, limit)

  const matches = summaryResults.map((r) => {
    return {
      turnIndex: r.turnIndex,
      summary: r,
      source: "cache",
    }
  })

  return res.json({ query, matches, count: matches.length, sessionId: sid })
})

app.get("/turns/:sessionId/search", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  const store = sessions.get(sid)
  if (!store) return res.status(404).json({ error: "session not found" })

  const rawQ = req.query.q
  const query = typeof rawQ === "string" ? rawQ : ""
  const rawLimit = req.query.limit
  const limit = Math.min(typeof rawLimit === "string" ? parseInt(rawLimit, 10) : 10, 50)

  // Global search across all cached summaries
  const results = summaryIndex.search(query, limit)

  return res.json({ query, results, count: results.length })
})

app.get("/state/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  const completedTurns = store.turns.filter((t) => !t.isCurrent)
  const currentTurn = store.turns.find((t) => t.isCurrent)
  const reservedTokens = currentTurn ? estimateTokens(currentTurn.messages) : 0
  const targetBudget = TOKEN_BUDGET - reservedTokens

  // Calculate hot/cold based on actual token budget
  let cumulativeTokens = 0
  let hotTurns = 0
  let coldTurns = 0
  for (const turn of [...completedTurns].reverse()) {
    cumulativeTokens += turn.tokenEstimate
    if (cumulativeTokens > targetBudget) {
      coldTurns++
    } else {
      hotTurns++
    }
  }

  return res.json({
    sourceLength: store.source.length,
    turnCount: store.turns.length,
    completedTurnCount: completedTurns.length,
    hotTurns,
    coldTurns,
    pendingSummaries: completedTurns.filter((t) => t.summaryStatus === "pending" || t.summaryStatus === "generating").length,
    doneSummaries: completedTurns.filter((t) => t.summaryStatus === "done").length,
    toolOutputCacheSize: store.toolOutputs.size,
    tokenBudget: TOKEN_BUDGET,
    reservedForCurrent: reservedTokens,
  })
})

app.get("/stats/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  return res.json({
    sourceLength: store.source.length,
    turnCount: store.turns.length,
    completedTurnCount: store.turns.filter((t) => !t.isCurrent).length,
    totalToolOutputs: store.toolOutputs.size,
    pendingSummaries: summaryQueue.filter((t) => t.sessionId === req.params.sessionId).length,
  })
})

app.delete("/session/:sessionId", (req: Request, res: Response) => {
  const sid = req.params.sessionId as string
  if (!SESSION_ID_PATTERN.test(sid)) {
    return res.status(400).json({ error: "invalid sessionId format" })
  }
  sessions.delete(sid)
  summaryIndex.deleteSession(sid)
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
      summaryIndex.deleteSession(id)
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

// ─── Startup ────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    sessions: sessions.size,
    pendingSummaries: summaryQueue.length,
    tokenBudget: TOKEN_BUDGET,
    maxHotTurns: MAX_HOT_TURNS,
  })
})

const PORT = server.port
app.listen(PORT, () => {
  console.log(`Transform server listening on http://localhost:${PORT}`)
  console.log(`Token budget: ${TOKEN_BUDGET}, max_hot_turns: ${MAX_HOT_TURNS}`)
})
