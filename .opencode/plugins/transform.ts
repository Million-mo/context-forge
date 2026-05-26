/**
 * OpenCode Plugin: Transform messages via external service
 *
 * Hook: experimental.chat.messages.transform
 * Sends completed turns to a local transform server for compression.
 * Each completed turn = one page. The current (active) turn is kept intact.
 *
 * Turn boundary: a turn ends when the next user message arrives.
 * Completed turns are sent to the server for compression (dedup + decay).
 * Current turn is never compressed — it waits for the next turn to close it.
 *
 * Flow:
 *   1. Split messages into completed turns + current turn
 *   2. Send completed turns to server (bucket-hash delta sync)
 *   3. Server compresses completed turns, returns updated turn data
 *   4. Client rebuilds messages: completed (compressed) + current (intact)
 *
 * Environment variables:
 *   TRANSFORM_SERVER_URL  - defaults to http://localhost:3000/sync
 *   BUCKET_SIZE          - messages per bucket, defaults to 10
 *   SESSION_ID           - session identifier for the server store
 */

import { createHash } from "crypto"

// ─── Types ───────────────────────────────────────────────────────────────────

interface Turn {
  index: number          // turn number (0-based)
  startIdx: number       // index in the full messages array where this turn begins
  endIdx: number         // index where this turn ends (exclusive)
  messages: any[]        // the actual messages belonging to this turn
  isCurrent: boolean     // true if this is the active (incomplete) turn
  messageCount: number
  tokenEstimate: number
}

interface SyncResponse {
  turns: {
    completed: TurnPayload[]
    currentTurnIndex: number
  }
  serverBucketHashes: Record<number, string>
}

interface TurnPayload {
  index: number
  messages: any[]
  isCurrent: boolean
}

// ─── Config ──────────────────────────────────────────────────────────────────

const SERVER_URL =
  process.env.TRANSFORM_SERVER_URL || "http://localhost:3000/sync"

const BUCKET_SIZE = parseInt(process.env.BUCKET_SIZE || "10", 10)
const SESSION_ID = process.env.SESSION_ID || "default"

// ─── In-memory state ──────────────────────────────────────────────────────────

const serverBucketHashes = new Map<number, string>() // index -> hash
let lastKnownTurnCount = 0

// ─── Utilities ────────────────────────────────────────────────────────────────

function estimateTokens(messages: any[]): number {
  // Rough estimate: 4 chars per token
  return Math.ceil(
    messages.reduce((sum, m) => sum + (JSON.stringify(m).length / 4), 0)
  )
}

function hashBucket(messages: any[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages))
    .digest("hex")
}

function getRole(msg: any): string {
  return msg?.info?.role || msg?.role || ""
}

/**
 * Split messages into turns.
 * A turn ends when the NEXT message is a user message.
 * The last turn is always marked as "current".
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

    // Turn boundary: previous message was NOT user, current message IS user
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
      })
      currentTurnStart = i
    }
  }

  // The final segment is always the current turn
  const finalMessages = messages.slice(currentTurnStart)
  turns.push({
    index: turns.length,
    startIdx: currentTurnStart,
    endIdx: messages.length,
    messages: finalMessages,
    isCurrent: true,
    messageCount: finalMessages.length,
    tokenEstimate: estimateTokens(finalMessages),
  })

  return turns
}

function buildTurnPayloads(turns: Turn[]): TurnPayload[] {
  return turns.map((t) => ({
    index: t.index,
    messages: t.messages,
    isCurrent: t.isCurrent,
  }))
}

function rebuildMessagesFromTurns(updatedTurns: TurnPayload[], currentTurnMessages: any[]): any[] {
  // completed turns come back compressed; current turn comes back intact
  const completed: any[] = []
  for (const t of updatedTurns) {
    if (!t.isCurrent) {
      completed.push(...t.messages)
    }
  }
  return [...completed, ...currentTurnMessages]
}

// ─── Plugin hook ─────────────────────────────────────────────────────────────

export const TransformPlugin = () => ({
  "experimental.chat.messages.transform": async (_input: any, output: any) => {
    if (!output?.messages || !Array.isArray(output.messages)) return

    const messages = output.messages
    if (messages.length === 0) return

    try {
      const turns = splitIntoTurns(messages)
      const completedTurns = turns.filter((t) => !t.isCurrent)
      const currentTurn = turns.find((t) => t.isCurrent)

      // Nothing to compress — only one turn and it's current
      if (completedTurns.length === 0) {
        return
      }

      // Check if we have any new completed turns since last sync
      if (completedTurns.length <= lastKnownTurnCount) {
        return
      }

      const newCompletedTurns = completedTurns.slice(lastKnownTurnCount)

      // Build bucket hashes for new completed turns
      const changedBuckets: { index: number; messages: any[]; turnIndex: number }[] = []
      for (const turn of newCompletedTurns) {
        for (let i = 0; i < turn.messages.length; i += BUCKET_SIZE) {
          const chunk = turn.messages.slice(i, i + BUCKET_SIZE)
          changedBuckets.push({
            index: turn.startIdx + i,
            messages: chunk,
            turnIndex: turn.index,
          })
        }
      }

      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          clientBucketHashes: Object.fromEntries(serverBucketHashes),
          changedBuckets,
          completedTurnCount: completedTurns.length,
          currentTurnIndex: currentTurn?.index ?? completedTurns.length,
        }),
      })

      if (!response.ok) {
        console.error(
          `[TransformPlugin] Server returned ${response.status}: ${response.statusText}`,
        )
        return
      }

      const data = await response.json() as SyncResponse

      // Update known hashes
      for (const [idx, hash] of Object.entries(data.serverBucketHashes)) {
        serverBucketHashes.set(parseInt(idx as string, 10), hash as string)
      }

      // Rebuild messages: compressed completed turns + intact current turn
      if (data.turns?.completed) {
        const merged = rebuildMessagesFromTurns(data.turns.completed, currentTurn?.messages ?? [])
        if (merged.length !== messages.length || JSON.stringify(merged) !== JSON.stringify(messages)) {
          output.messages.splice(0, output.messages.length, ...merged)
        }
        lastKnownTurnCount = completedTurns.length
      }
    } catch (err) {
      console.error(`[TransformPlugin] Failed to sync with transform server:`, err)
    }
  },
})

export default TransformPlugin
