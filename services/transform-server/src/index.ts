import express from "express"
import type { Request, Response } from "express"
import { createHash } from "crypto"

const app = express()
app.use(express.json({ limit: "10mb" }))

// ─── Types ───────────────────────────────────────────────────────────────────

type BucketHashes = Record<number, string> // bucketIndex -> hash

type SessionStore = {
  messages: any[]         // full message array
  bucketHashes: BucketHashes
  createdAt: number
}

// ─── Storage ─────────────────────────────────────────────────────────────────

const sessions = new Map<string, SessionStore>()

const BUCKET_SIZE = parseInt(process.env.BUCKET_SIZE || "10", 10)

// ─── Hash utilities ───────────────────────────────────────────────────────────

function hashMessages(messages: any[]): BucketHashes {
  const buckets: Record<number, string> = {}
  for (let i = 0; i < messages.length; i += BUCKET_SIZE) {
    const bucket = messages.slice(i, i + BUCKET_SIZE)
    const content = JSON.stringify(bucket)
    buckets[i / BUCKET_SIZE] = createHash("sha256").update(content).digest("hex")
  }
  return buckets
}

function hashChangedBuckets(
  changedBuckets: { index: number; messages: any[] }[],
): BucketHashes {
  const result: BucketHashes = {}
  for (const { index, messages } of changedBuckets) {
    const content = JSON.stringify(messages)
    result[index] = createHash("sha256").update(content).digest("hex")
  }
  return result
}

function mergeBuckets(
  existing: any[],
  changedBuckets: { index: number; messages: any[] }[],
  newBucketCount: number,
): any[] {
  // Rebuild full array from changed buckets
  const bucketMap = new Map<number, any[]>()
  for (const { index, messages } of changedBuckets) {
    bucketMap.set(index, messages)
  }

  const result: any[] = []
  for (let i = 0; i < newBucketCount; i++) {
    if (bucketMap.has(i)) {
      result.push(...bucketMap.get(i)!)
    } else {
      result.push(...(existing.slice(i * BUCKET_SIZE, (i + 1) * BUCKET_SIZE) || []))
    }
  }
  return result
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * Delta sync: client sends changed buckets only
 * Body: {
 *   sessionId: string,
 *   clientBucketHashes: BucketHashes,   // client's current view
 *   changedBuckets: { index: number, messages: any[] }[]  // only buckets that differ
 * }
 */
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
    // First sync — no existing state, treat all changedBuckets as full state
    const allMessages = changedBuckets.flatMap((b: any) => b.messages)
    const serverBucketHashes = hashChangedBuckets(changedBuckets)

    store = {
      messages: allMessages,
      bucketHashes: serverBucketHashes,
      createdAt: Date.now(),
    }
    sessions.set(sessionId, store)

    console.log(
      `[${new Date().toISOString()}] [${sessionId}] init: ${allMessages.length} msgs, ${changedBuckets.length} buckets`,
    )

    return res.json({
      serverBucketHashes,
      fullMessages: allMessages,
    })
  }

  // Server knows this session — merge changed buckets
  const newHashes = hashChangedBuckets(changedBuckets)
  const newBucketCount = Math.max(
    ...changedBuckets.map((b: any) => b.index),
    ...Object.keys(store.bucketHashes).map(Number),
  ) + 1

  const mergedMessages = mergeBuckets(store.messages, changedBuckets, newBucketCount)
  const serverBucketHashes = hashMessages(mergedMessages)

  store.messages = mergedMessages
  store.bucketHashes = serverBucketHashes

  // Check which buckets the client is missing or stale
  const staleBuckets: { index: number; messages: any[] }[] = []
  for (const [idxStr, serverHash] of Object.entries(serverBucketHashes)) {
    const idx = parseInt(idxStr, 10)
    const clientHash = clientBucketHashes?.[idx]
    if (!clientHash || clientHash !== serverHash) {
      const start = idx * BUCKET_SIZE
      staleBuckets.push({
        index: idx,
        messages: mergedMessages.slice(start, start + BUCKET_SIZE),
      })
    }
  }

  console.log(
    `[${new Date().toISOString()}] [${sessionId}] sync: ${changedBuckets.length} changed → ${mergedMessages.length} msgs, ${staleBuckets.length} stale buckets`,
  )

  return res.json({
    serverBucketHashes,
    staleBuckets,
  })
})

/**
 * Full state (no delta, raw messages) — fallback / reset
 */
app.post("/submit", (req: Request, res: Response) => {
  const { sessionId, messages } = req.body

  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" })
  }
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" })
  }

  const serverBucketHashes = hashMessages(messages)
  sessions.set(sessionId, {
    messages,
    bucketHashes: serverBucketHashes,
    createdAt: Date.now(),
  })

  console.log(
    `[${new Date().toISOString()}] [${sessionId}] full submit: ${messages.length} msgs`,
  )

  return res.json({ serverBucketHashes })
})

/**
 * Get current state for a session
 */
app.get("/state/:sessionId", (req: Request, res: Response) => {
  const store = sessions.get(req.params.sessionId as string)
  if (!store) {
    return res.status(404).json({ error: "session not found" })
  }
  return res.json({
    messages: store.messages,
    bucketHashes: store.bucketHashes,
  })
})

/**
 * Delete a session
 */
app.delete("/session/:sessionId", (req: Request, res: Response) => {
  sessions.delete(req.params.sessionId as string)
  return res.json({ ok: true })
})

// ─── Housekeeping ─────────────────────────────────────────────────────────────

setInterval(() => {
  const now = Date.now()
  const TTL = parseInt(process.env.SESSION_TTL || "600000", 10) // 10 min default
  let evicted = 0
  for (const [id, store] of sessions) {
    if (now - store.createdAt > TTL) {
      sessions.delete(id)
      evicted++
    }
  }
  console.log(`[${new Date().toISOString()}] Sessions: ${sessions.size} active, ${evicted} evicted`)
}, 5 * 60 * 1000)

// ─── Startup ──────────────────────────────────────────────────────────────────

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", sessions: sessions.size })
})

const PORT = parseInt(process.env.PORT || "3000", 10)
app.listen(PORT, () => {
  console.log(`Transform server listening on http://localhost:${PORT}`)
  console.log(`POST http://localhost:${PORT}/sync        <- delta sync (bucket hash)`)
  console.log(`POST http://localhost:${PORT}/submit     <- full state submit`)
  console.log(`GET  http://localhost:${PORT}/state/:id  <- get current state`)
  console.log(`DELETE http://localhost:${PORT}/session/:id <- delete session`)
  console.log(`BUCKET_SIZE=${BUCKET_SIZE}, SESSION_TTL=${process.env.SESSION_TTL || "600000"}ms`)
})
