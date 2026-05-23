import express from "express"
import type { Request, Response } from "express"
import { createHash } from "crypto"

const app = express()
app.use(express.json({ limit: "10mb" }))

// ─── Types ───────────────────────────────────────────────────────────────────

type BucketHashes = Record<number, string>

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

type ToolOutputEntry = {
  idx: number           // index in source array
  compressed: boolean
  level: CompressionLevel
  originalOutput: string
  compressedOutput: string
  timestamp: number
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

const DECAY_FULL_MS = parseInt(process.env.DECAY_FULL_MS || "300000", 10)
const DECAY_SUMMARY_MS = parseInt(process.env.DECAY_SUMMARY_MS || "900000", 10)
const DECAY_PLACEHOLDER_MS = parseInt(process.env.DECAY_PLACEHOLDER_MS || "1800000", 10)

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
          part.state._compressed = true
          part.state._compressedReason = "duplicate"
          continue
        }
      }

      if (key && decay.has(key) && decay.get(key)!.idx === i) {
        const entry = decay.get(key)!
        if (entry.compressed && !part.state?._compressed) {
          part.state.output = entry.compressedOutput
        }
      }
    }

    result.push(cloned)
  }
  return result
}

// ─── Compression helpers ───────────────────────────────────────────────────────

function getCompressionLevel(toolAgeMs: number): CompressionLevel {
  if (toolAgeMs < DECAY_FULL_MS) return "full"
  if (toolAgeMs < DECAY_FULL_MS + DECAY_SUMMARY_MS) return "summary"
  if (toolAgeMs < DECAY_FULL_MS + DECAY_SUMMARY_MS + DECAY_PLACEHOLDER_MS) return "placeholder"
  return "minimal"
}

function compressToolOutput(toolName: string, state: any, level: CompressionLevel): string {
  const input = state?.input || {}
  const output = state?.output || ""

  switch (toolName) {
    case "Read": {
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
          return `[COMPRESSED: Read "${input.file || input.path || "?"}"]\n${preview}`
        }
        case "placeholder":
          return `[COMPRESSED: Read "${input.file || input.path || "?"}" — ${lineCount} lines]`
        default:
          return `[COMPRESSED: Read "${input.file || input.path || "?"}"]`
      }
    }
    case "Glob": {
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: Glob "${input.pattern || "?"}"] — ${count} matches: ${lines.slice(0, 5).join(", ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder":
          return `[COMPRESSED: Glob "${input.pattern || "?"}" — ${count} matches]`
        default:
          return `[COMPRESSED: Glob "${input.pattern || "?"}"]`
      }
    }
    case "Grep": {
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: Grep "${input.pattern || "?"}"] — ${count} matches: ${lines.slice(0, 5).join(" | ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder":
          return `[COMPRESSED: Grep "${input.pattern || "?"}" — ${count} matches]`
        default:
          return `[COMPRESSED: Grep "${input.pattern || "?"}"]`
      }
    }
    case "WebFetch": {
      const size = new TextEncoder().encode(output).length
      switch (level) {
        case "full": return output
        case "summary": return `[COMPRESSED: WebFetch "${input.url || "?"}"]\n${output.slice(0, 200)}...`
        case "placeholder": return `[COMPRESSED: WebFetch "${input.url || "?"}" — ${size} bytes]`
        default: return `[COMPRESSED: WebFetch "${input.url || "?"}"]`
      }
    }
    case "WebSearch": {
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: WebSearch "${input.query || input.term || "?"}"] — ${count} results: ${lines.slice(0, 3).join(" | ")}`
        case "placeholder":
          return `[COMPRESSED: WebSearch "${input.query || input.term || "?"}" — ${count} results]`
        default:
          return `[COMPRESSED: WebSearch "${input.query || input.term || "?"}"]`
      }
    }
    default:
      return `[COMPRESSED: ${toolName} — output truncated]`
  }
}

const CACHEABLE_TOOLS: Set<string> = new Set([
  "Read", "Glob", "Grep", "WebFetch", "WebSearch",
])

function getToolOutputKey(toolName: string, state: any): string | null {
  const input = state?.input || {}
  switch (toolName) {
    case "Read":    return `file:${input.file || input.path || ""}`
    case "Glob":    return `glob:${input.pattern || ""}`
    case "Grep":    return `grep:${input.pattern || ""}:${input.path || ""}`
    case "WebFetch":return `url:${input.url || ""}`
    case "WebSearch":return `search:${input.query || input.term || ""}`
    default:        return null
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
            np.state._compressed = true
            np.state._compressedReason = "duplicate"
          }
        }
      }

      latestOf.set(key, i)
    }
  }

  store.lastCompressedIdx = userMsgIdx

  // ── Step 2: Time decay for latest entries in NEW range ──
  // Only apply decay to entries in [lastDecayedIdx, userMsgIdx) to avoid re-decaying.
  const decayStart = store.lastDecayedIdx
  for (const [key, idx] of latestOf) {
    if (idx < decayStart) continue // already decayed

    const msg = source[idx]
    const toolPart = (msg?.parts || []).find((p: any) => p.type === "tool")
    if (!toolPart) continue

    const toolName: string = toolPart.tool || ""
    const existing = store.toolOutputs.get(key)
    const ageMs = now - (existing?.timestamp || now)
    const level = getCompressionLevel(ageMs)

    if (existing && existing.idx === idx) {
      if (level !== existing.level) {
        existing.level = level
        existing.compressed = level !== "full"
        existing.compressedOutput = compressToolOutput(toolName, toolPart.state || {}, level)
      }
    } else {
      store.toolOutputs.set(key, {
        idx,
        compressed: level !== "full",
        level,
        originalOutput: toolPart.state?.output?.toString() || "",
        compressedOutput: compressToolOutput(toolName, toolPart.state || {}, level),
        timestamp: now,
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
