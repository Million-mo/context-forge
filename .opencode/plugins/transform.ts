/**
 * OpenCode Plugin: Transform messages via external service
 *
 * Hook: experimental.chat.messages.transform
 * Sends messages to a local transform server using bucket-hash delta sync
 *
 * Flow:
 *   1. Split messages into buckets of N messages each
 *   2. Compute SHA-256 hash for each bucket
 *   3. Compare with server's known bucket hashes (stored in memory)
 *   4. Send only buckets whose hash differs from server's view
 *   5. Server merges changed buckets, returns stale buckets for client to update
 *
 * Environment variables:
 *   TRANSFORM_SERVER_URL  - defaults to http://localhost:3000/sync
 *   BUCKET_SIZE          - messages per bucket, defaults to 10
 *   SESSION_ID           - session identifier for the server store
 */

import { createHash } from "crypto"

const SERVER_URL =
  process.env.TRANSFORM_SERVER_URL || "http://localhost:3000/sync"

const BUCKET_SIZE = parseInt(process.env.BUCKET_SIZE || "10", 10)
const SESSION_ID = process.env.SESSION_ID || "default"

// ─── In-memory state ──────────────────────────────────────────────────────────

const serverBucketHashes = new Map<number, string>() // index -> hash

// ─── Hash utilities ───────────────────────────────────────────────────────────

function hashBucket(messages: any[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
}

function chunkMessages(messages: any[]): { index: number; messages: any[] }[] {
  const buckets: { index: number; messages: any[] }[] = []
  for (let i = 0; i < messages.length; i += BUCKET_SIZE) {
    buckets.push({
      index: i / BUCKET_SIZE,
      messages: messages.slice(i, i + BUCKET_SIZE),
    })
  }
  return buckets
}

// ─── Plugin hook ─────────────────────────────────────────────────────────────

export const TransformPlugin = () => ({
  "experimental.chat.messages.transform": async (_input: any, output: any) => {
    if (!output?.messages || !Array.isArray(output.messages)) return

    const messages = output.messages
    if (messages.length === 0) return

    try {
      // Build current bucket hashes
      const buckets = chunkMessages(messages)
      const clientHashes: Record<number, string> = {}
      for (const { index, messages: bucketMsgs } of buckets) {
        clientHashes[index] = hashBucket(bucketMsgs)
      }

      // Find changed buckets (hash differs from server's known hash)
      const changedBuckets = buckets.filter(({ index, messages: bucketMsgs }) => {
        const knownHash = serverBucketHashes.get(index)
        const currentHash = clientHashes[index]
        return knownHash !== currentHash
      })

      // Nothing changed
      if (changedBuckets.length === 0) {
        return
      }

      // Build clientBucketHashes for comparison
      const clientBucketHashes: Record<number, string> = {}
      for (const [idx, hash] of serverBucketHashes) {
        clientBucketHashes[idx] = hash
      }

      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          clientBucketHashes,
          changedBuckets,
        }),
      })

      if (!response.ok) {
        console.error(
          `[TransformPlugin] Server returned ${response.status}: ${response.statusText}`,
        )
        return
      }

      const data = await response.json() as {
        serverBucketHashes: Record<number, string>
        staleBuckets?: { index: number; messages: any[] }[]
        fullMessages?: any[]
      }

      // If server returned full state (first sync), use it
      if (data.fullMessages) {
        serverBucketHashes.clear()
        for (const [idx, hash] of Object.entries(data.serverBucketHashes)) {
          serverBucketHashes.set(parseInt(idx, 10), hash)
        }
        output.messages.splice(0, output.messages.length, ...data.fullMessages)
        return
      }

      // Update known server hashes
      for (const [idx, hash] of Object.entries(data.serverBucketHashes)) {
        serverBucketHashes.set(parseInt(idx, 10), hash)
      }

      // Apply stale buckets from server (server has newer data)
      if (data.staleBuckets && data.staleBuckets.length > 0) {
        const allBuckets = chunkMessages(messages)

        for (const stale of data.staleBuckets) {
          const existingIdx = allBuckets.findIndex((b) => b.index === stale.index)
          if (existingIdx >= 0) {
            allBuckets[existingIdx].messages = stale.messages
          } else {
            allBuckets.push(stale)
          }
        }

        // Sort and flatten
        allBuckets.sort((a, b) => a.index - b.index)
        const merged = allBuckets.flatMap((b) => b.messages)

        if (merged.length !== messages.length || JSON.stringify(merged) !== JSON.stringify(messages)) {
          output.messages.splice(0, output.messages.length, ...merged)
        }
      }
    } catch (err) {
      console.error(`[TransformPlugin] Failed to sync with transform server:`, err)
    }
  },
})

export default TransformPlugin
