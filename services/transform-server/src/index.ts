import express from "express"
import type { Request, Response } from "express"
import { createHash } from "crypto"

const app = express()
app.use(express.json({ limit: "10mb" }))

// ─── Types ───────────────────────────────────────────────────────────────────

type BucketHashes = Record<number, string>

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

type ToolOutputEntry = {
  idx: number           // 首次调用的 index
  lastCallIdx: number   // 最近一次调用的 index
  callCount: number     // 调用次数
  toolType: string      // 工具类型：read, glob, grep, web_fetch, web_search
  compressed: boolean
  level: CompressionLevel
  originalOutput: string
  compressedOutput: string
  timestamp: number     // 首次调用的时间
  lastCallTime: number  // 最近一次调用的时间
}

type SessionStore = {
  source: any[]                         // source of truth, matches OpenCode, append-only
  compressed: any[]                      // compressed view for LLM
  compressedBucketHashes: BucketHashes   // hash of compressed view
  lastCompressedIdx: number              // all source[0..<lastCompressedIdx) deduplicated
  lastDecayedIdx: number                // all source[0..<lastDecayedIdx) decay applied
  toolOutputs: Map<string, ToolOutputEntry>
  createdAt: number
}

// ─── Configuration ────────────────────────────────────────────────────────────

const BUCKET_SIZE = parseInt(process.env.BUCKET_SIZE || "10", 10)

// Time thresholds (in ms) — still used as baseline
const DECAY_FULL_MS = parseInt(process.env.DECAY_FULL_MS || "300000", 10)
const DECAY_SUMMARY_MS = parseInt(process.env.DECAY_SUMMARY_MS || "900000", 10)
const DECAY_PLACEHOLDER_MS = parseInt(process.env.DECAY_PLACEHOLDER_MS || "1800000", 10)

// Decay weight configuration — can be tuned via experiments
const DECAY_WEIGHTS = {
  // Distance weight: importance of message distance (higher = distance matters more)
  distance: parseFloat(process.env.DECAY_WEIGHT_DISTANCE || "1.0"),
  // Time weight: importance of time age (higher = time matters more)
  time: parseFloat(process.env.DECAY_WEIGHT_TIME || "0.3"),
  // Frequency weight: importance of call count (higher = frequent calls decay slower)
  frequency: parseFloat(process.env.DECAY_WEIGHT_FREQUENCY || "0.5"),
}

// Tool type decay modifiers — different tools decay at different rates
const TOOL_DECAY_MODIFIERS: Record<string, number> = {
  read: 0.8,        // Read is stable, decay slower
  glob: 0.6,        // Glob results change with file structure
  grep: 0.7,        // Grep results change with code
  webfetch: 1.5,    // Web content changes frequently
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionStore>()
const compressionQueue = new Map<string, number>() // sessionId -> target userMsgIdx

// ─── Hash utilities ────────────────────────────────────────────────────────────

function hashArray(messages: any[], bucketSize: number): BucketHashes {
  const buckets: Record<number, string> = {}
  for (let i = 0; i < messages.length; i += bucketSize) {
    const bucket = messages.slice(i, i + bucketSize)
    const content = JSON.stringify(bucket)
    buckets[i / bucketSize] = createHash("sha256").update(content).digest("hex")
  }
  return buckets
}

function buildCompressedFromSource(
  source: any[],
  start: number,
  end: number,
  dedup: Map<string, number>,
  decay: Map<string, ToolOutputEntry>,
): any[] {
  // Returns a shallow copy of source[start..end) with tool outputs modified
  const result: any[] = []
  for (let i = start; i < end; i++) {
    const msg = source[i]
    const role = msg?.info?.role || msg?.role

    if (role !== "assistant") {
      result.push(msg)
      continue
    }

    // Deep clone the message so we don't mutate source
    const cloned = JSON.parse(JSON.stringify(msg))

    for (const part of cloned.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue

      const toolName: string = part.tool || ""
      const key = getToolOutputKey(toolName, part.state)

      if (key && dedup.has(key)) {
        // This entry is a duplicate — replace output
        const newerIdx = dedup.get(key)!
        if (newerIdx !== i) {
          const input = part.state?.input || {}
          const file = input.file || input.path || input.pattern || "?"
          part.state.output = `[COMPRESSED: duplicate of ${toolName} "${file}" at position ${newerIdx}]`
          continue
        }
      }

      if (key && decay.has(key)) {
        const entry = decay.get(key)!
        // Apply decay only if this is the latest call for this key
        if (entry.compressed && entry.lastCallIdx === i) {
          part.state.output = entry.compressedOutput
        }
      }

      // Clean up internal markers (if any exist from previous runs)
      delete part.state._compressed
      delete part.state._compressedReason
    }

    result.push(cloned)
  }
  return result
}

// ─── Compression helpers ───────────────────────────────────────────────────────

type DecayContext = {
  currentUserIdx: number  // Current user message index
  now: number             // Current timestamp
}

/**
 * Normalize tool name to category for decay modifier lookup
 */
function getToolCategory(toolName: string): string {
  return toolName.toLowerCase()
}

/**
 * Calculate decay score based on multiple factors.
 * Higher score = more decayed (less important).
 * 
 * Factors:
 * - Distance: how far this tool call is from current user message
 * - Time: how long since the last call
 * - Frequency: how many times this tool has been called
 * - Tool type: different tools decay at different rates
 */
function calculateDecayScore(
  entry: ToolOutputEntry,
  ctx: DecayContext
): number {
  const { distance: wDist, time: wTime, frequency: wFreq } = DECAY_WEIGHTS
  
  // 1. Distance score (exponential decay based on message distance)
  // Closer to current message = lower score = less decayed
  const msgDistance = ctx.currentUserIdx - entry.lastCallIdx
  const distanceScore = Math.min(msgDistance / 20, 5) // Cap at 5 to avoid extreme values
  
  // 2. Time score (logarithmic to reduce extreme time effects)
  // Longer time = higher score = more decayed
  const timeAgeMs = ctx.now - entry.lastCallTime
  const timeAgeMinutes = timeAgeMs / 60000
  const timeScore = Math.log2(timeAgeMinutes + 1) * wTime
  
  // 3. Frequency score (inverse relationship)
  // More calls = lower score = less decayed
  const frequencyScore = Math.log2(entry.callCount + 1) * wFreq
  
  // 4. Tool-specific modifier
  const toolModifier = TOOL_DECAY_MODIFIERS[entry.toolType] || 1.0
  
  // Combined score with tool modifier
  const baseScore = distanceScore * wDist + timeScore - frequencyScore
  const finalScore = baseScore * toolModifier
  
  // Normalize to 0-10 range for level thresholds
  return Math.max(0, Math.min(finalScore, 10))
}

function getCompressionLevel(
  entry: ToolOutputEntry,
  ctx: DecayContext
): CompressionLevel {
  const score = calculateDecayScore(entry, ctx)
  
  // Thresholds for compression levels
  if (score < 2) return "full"         // Low decay, keep full
  if (score < 5) return "summary"     // Medium decay, summarize
  if (score < 8) return "placeholder"  // High decay, placeholder only
  return "minimal"                      // Very high decay, minimal
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

// ─── Core compression ─────────────────────────────────────────────────────────

/**
 * Compress source[0..userMsgIdx) in two steps:
 * 1. Deduplication — backward scan, mark older duplicates
 * 2. Time decay — apply to latest entries in the NEW range only
 *
 * Then rebuild compressed[] to match.
 */
function compressUpTo(store: SessionStore, userMsgIdx: number): void {
  const source = store.source
  if (userMsgIdx <= 0) return

  const now = Date.now()

  // ── Step 1: Deduplication [0, userMsgIdx) ──
  // Backward scan: for each depKey, the LATEST occurrence is kept intact,
  // all earlier ones get marked as duplicate.
  // Result is IDEMPOTENT — safe to recompute from 0 every time.
  const latestOf = new Map<string, number>()

  for (let i = userMsgIdx - 1; i >= 0; i--) {
    const msg = source[i]
    const role = msg?.info?.role || msg?.role
    if (role !== "assistant") continue

    for (const part of msg.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName: string = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue

      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue

      if (latestOf.has(key)) {
        // Older duplicate found — the newer one (at latestOf.get(key)) is kept.
        // Mark this older one in source so rebuild picks it up.
        const newerIdx = latestOf.get(key)!
        const newerMsg = source[newerIdx]
        if (newerMsg) {
          for (const np of newerMsg.parts || []) {
            if (np.type !== "tool") continue
            const npInput = np.state?.input || {}
            const npFile = npInput.file || npInput.path || npInput.pattern || "?"
            np.state.output = `[COMPRESSED: duplicate of ${np.tool || toolName} "${npFile}" at position ${i}]`
          }
        }
      }

      latestOf.set(key, i)
    }
  }

  store.lastCompressedIdx = userMsgIdx

  // ── Step 2: Decay based on multi-factor scoring ──
  // Build decay context with current position
  const decayCtx: DecayContext = {
    currentUserIdx: userMsgIdx,
    now,
  }

  for (const [key, idx] of latestOf) {
    const msg = source[idx]
    const toolPart = (msg?.parts || []).find((p: any) => p.type === "tool")
    if (!toolPart) continue

    const toolName: string = toolPart.tool || ""
    const toolCategory = getToolCategory(toolName)
    const existing = store.toolOutputs.get(key)
    const ageMs = now - (existing?.lastCallTime || existing?.timestamp || now)

    // Calculate decay score using multi-factor formula
    const entryForScore: ToolOutputEntry = existing ? {
      ...existing,
      lastCallIdx: existing.lastCallIdx || existing.idx,
      lastCallTime: existing.lastCallTime || existing.timestamp,
    } : {
      idx,
      lastCallIdx: idx,
      callCount: 1,
      toolType: toolCategory,
      compressed: false,
      level: "full",
      originalOutput: "",
      compressedOutput: "",
      timestamp: now,
      lastCallTime: now,
    }

    const level = getCompressionLevel(entryForScore, decayCtx)

    if (existing) {
      // Update existing entry
      if (level !== existing.level) {
        existing.level = level
        existing.compressed = level !== "full"
        existing.compressedOutput = compressToolOutput(toolName, toolPart.state || {}, level)
      }
      // Update call tracking
      existing.lastCallIdx = idx
      existing.lastCallTime = now
      existing.callCount = (existing.callCount || 1) + 1
    } else {
      // Create new entry
      store.toolOutputs.set(key, {
        idx,
        lastCallIdx: idx,
        callCount: 1,
        toolType: toolCategory,
        compressed: level !== "full",
        level,
        originalOutput: toolPart.state?.output?.toString() || "",
        compressedOutput: compressToolOutput(toolName, toolPart.state || {}, level),
        timestamp: now,
        lastCallTime: now,
      })
    }
  }

  store.lastDecayedIdx = userMsgIdx

  // ── Step 3: Rebuild compressed view ──
  store.compressed = buildCompressedFromSource(
    source, 0, userMsgIdx,
    latestOf,
    store.toolOutputs,
  )

  // Append unprocessed source tail to compressed
  for (let i = userMsgIdx; i < source.length; i++) {
    store.compressed.push(source[i])
  }

  store.compressedBucketHashes = hashArray(store.compressed, BUCKET_SIZE)

  console.log(
    `[${new Date().toISOString()}] compressed [0, ${userMsgIdx}), dedup deps: ${latestOf.size}, ` +
    `total source: ${source.length}, compressed: ${store.compressed.length}`,
  )
}

// ─── Background worker ────────────────────────────────────────────────────────

let isWorkerRunning = false

async function runWorker(): Promise<void> {
  if (isWorkerRunning) return
  isWorkerRunning = true
  try {
    for (const [sessionId, userMsgIdx] of compressionQueue) {
      const store = sessions.get(sessionId)
      if (!store) {
        compressionQueue.delete(sessionId)
        continue
      }
      compressUpTo(store, userMsgIdx)
      compressionQueue.delete(sessionId)
    }
  } finally {
    isWorkerRunning = false
  }
}

function queueCompression(sessionId: string, userMsgIdx: number): void {
  compressionQueue.set(sessionId, userMsgIdx)
  setImmediate(() => runWorker())
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post("/sync", (req: Request, res: Response) => {
  const { sessionId, clientBucketHashes, changedBuckets } = req.body

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" })
  }
  if (!Array.isArray(changedBuckets)) {
    return res.status(400).json({ error: "changedBuckets must be an array" })
  }

  let store = sessions.get(sessionId)

  if (!store) {
    // First sync
    const source = changedBuckets.flatMap((b: any) => b.messages)

    store = {
      source,
      compressed: JSON.parse(JSON.stringify(source)),
      compressedBucketHashes: hashArray(source, BUCKET_SIZE),
      lastCompressedIdx: 0,
      lastDecayedIdx: 0,
      toolOutputs: new Map(),
      createdAt: Date.now(),
    }

    // Find first user message
    let firstUserIdx = -1
    for (let i = 0; i < source.length; i++) {
      const role = source[i]?.info?.role || source[i]?.role
      if (role === "user") { firstUserIdx = i; break }
    }

    if (firstUserIdx > 0) {
      queueCompression(sessionId, firstUserIdx)
    }

    sessions.set(sessionId, store)

    return res.json({
      compressedBucketHashes: store.compressedBucketHashes,
      compressedMessages: store.compressed,
    })
  }

  // Merge new buckets into source (append-only merge)
  const prevLen = store.source.length
  const newBucketCount = Math.max(
    ...changedBuckets.map((b: any) => b.index),
    ...Object.keys(store.compressedBucketHashes).map(Number),
  ) + 1

  const merged = mergeInto(store.source, changedBuckets, newBucketCount)

  // Detect new indices
  const prevSet = new Set(store.source.map((m) => JSON.stringify(m)))
  const newIndices: number[] = []
  for (let i = prevLen; i < merged.length; i++) {
    if (!prevSet.has(JSON.stringify(merged[i]))) newIndices.push(i)
  }

  store.source = merged

  // Find user messages in new range
  let firstNewUserIdx = -1
  for (const idx of newIndices) {
    const role = store.source[idx]?.info?.role || store.source[idx]?.role
    if (role === "user") { firstNewUserIdx = idx; break }
  }

  // Find the earliest user message in entire source (for recompression anchor)
  let firstUserIdx = -1
  for (let i = 0; i < store.source.length; i++) {
    const role = store.source[i]?.info?.role || store.source[i]?.role
    if (role === "user") { firstUserIdx = i; break }
  }

  if (firstUserIdx > 0) {
    queueCompression(sessionId, firstUserIdx)
  }

  // Build stale buckets from compressed view
  const compressedBucketHashes = store.compressedBucketHashes
  const staleBuckets: { index: number; messages: any[] }[] = []
  for (const [idxStr, hash] of Object.entries(compressedBucketHashes)) {
    const idx = parseInt(idxStr, 10)
    const clientHash = clientBucketHashes?.[idx]
    if (!clientHash || clientHash !== hash) {
      const start = idx * BUCKET_SIZE
      staleBuckets.push({
        index: idx,
        messages: store.compressed.slice(start, start + BUCKET_SIZE),
      })
    }
  }

  console.log(
    `[${new Date().toISOString()}] [${sessionId}] sync: source ${store.source.length}, ` +
    `compressed ${store.compressed.length}, new ${newIndices.length}, stale ${staleBuckets.length}`,
  )

  return res.json({ compressedBucketHashes, staleBuckets })
})

function mergeInto(existing: any[], changedBuckets: { index: number; messages: any[] }[], newBucketCount: number): any[] {
  const bucketMap = new Map<number, any[]>()
  for (const { index, messages } of changedBuckets) {
    bucketMap.set(index, messages)
  }

  const result: any[] = [...existing]
  for (let i = existing.length; i < newBucketCount * BUCKET_SIZE; i++) {
    if (bucketMap.has(i / BUCKET_SIZE)) {
      result.push(...bucketMap.get(i / BUCKET_SIZE)!)
    }
  }
  return result
}

app.post("/submit", (req: Request, res: Response) => {
  const { sessionId, messages } = req.body

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" })
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" })
  }

  const store: SessionStore = {
    source: messages,
    compressed: JSON.parse(JSON.stringify(messages)),
    compressedBucketHashes: hashArray(messages, BUCKET_SIZE),
    lastCompressedIdx: 0,
    lastDecayedIdx: 0,
    toolOutputs: new Map(),
    createdAt: Date.now(),
  }

  let firstUserIdx = -1
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.info?.role || messages[i]?.role
    if (role === "user") { firstUserIdx = i; break }
  }

  if (firstUserIdx > 0) {
    queueCompression(sessionId, firstUserIdx)
  }

  sessions.set(sessionId, store)

  return res.json({ compressedBucketHashes: store.compressedBucketHashes })
})

app.get("/state/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })
  return res.json({
    sourceLength: store.source.length,
    compressedLength: store.compressed.length,
    compressedBucketHashes: store.compressedBucketHashes,
    lastCompressedIdx: store.lastCompressedIdx,
    lastDecayedIdx: store.lastDecayedIdx,
  })
})

app.get("/stats/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) return res.status(404).json({ error: "session not found" })

  let compressedCount = 0, fullCount = 0
  const byTool: Record<string, number> = {}
  for (const [, entry] of store.toolOutputs) {
    if (entry.compressed) compressedCount++; else fullCount++
    const part = store.source[entry.idx]?.parts?.find((p: any) => p.type === "tool")
    const tool = part?.tool || "?"
    byTool[tool] = (byTool[tool] || 0) + 1
  }

  return res.json({
    sourceLength: store.source.length,
    compressedLength: store.compressed.length,
    totalToolOutputs: store.toolOutputs.size,
    fullOutputs: fullCount,
    compressedOutputs: compressedCount,
    byTool,
    pendingCompression: compressionQueue.get(req.params.sessionId as string) ?? null,
  })
})

app.delete("/session/:sessionId", (req: Request, res: Response) => {
  sessions.delete(req.params.sessionId as string)
  compressionQueue.delete(req.params.sessionId as string)
  return res.json({ ok: true })
})

// ─── Housekeeping ─────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  const TTL = parseInt(process.env.SESSION_TTL || "600000", 10)
  let evicted = 0
  for (const [id] of sessions) {
    if (now - (sessions.get(id)?.createdAt || 0) > TTL) {
      sessions.delete(id)
      compressionQueue.delete(id)
      evicted++
    }
  }
  console.log(`[${new Date().toISOString()}] Sessions: ${sessions.size}, evicted: ${evicted}`)
}, 5 * 60 * 1000)

// ─── Startup ──────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: sessions.size, pending: compressionQueue.size })
})

const PORT = parseInt(process.env.PORT || "3000", 10)
app.listen(PORT, () => {
  console.log(`Transform server listening on http://localhost:${PORT}`)
  console.log(
    `Decay: full<${DECAY_FULL_MS}ms, summary<${DECAY_FULL_MS + DECAY_SUMMARY_MS}ms, placeholder<${DECAY_FULL_MS + DECAY_SUMMARY_MS + DECAY_PLACEHOLDER_MS}ms`,
  )
})
