/**
 * OpenCode Plugin: Transform messages via external service
 *
 * Hook: experimental.chat.messages.transform
 * Sends the full message history to a local transform server for compression.
 * The server applies dedup + decay compression on completed turns.
 * Current turn (active) is kept intact and returned as-is.
 *
 * The server is the single source of truth for compressed state.
 * Each sync replaces the entire session state on the server.
 *
 * Environment variables:
 *   TRANSFORM_SERVER_URL  - defaults to http://localhost:3000
 *   SESSION_ID           - session identifier for the server store
 */

interface SyncResponse {
  messages: any[]
}

// ─── Config ─────────────────────────────────────────────────────────────────

const SERVER_BASE =
  process.env.TRANSFORM_SERVER_URL || "http://localhost:3000"
const SERVER_URL = `${SERVER_BASE}/sync`
const SERVER_SEARCH_URL = `${SERVER_BASE}/search`

const SESSION_ID = process.env.SESSION_ID || "default"

// ─── Utilities ───────────────────────────────────────────────────────────────

function getRole(msg: any): string {
  return msg?.info?.role || msg?.role || ""
}

function getText(parts: any[]): string {
  let text = ""
  for (const p of parts) {
    if (p?.type === "text") text += p.text ?? ""
  }
  return text.trim()
}

/**
 * Detect if the user's message is asking about historical context.
 */
function detectHistoryQuery(parts: any[]): string | null {
  const text = getText(parts).toLowerCase()
  if (!text) return null

  const patterns = [
    /\b(earlier|before|previously|last time|last session|last I|revisit|follow up)\b/,
    /\b(what did I do|what was I working on|show me my|continue that|repeat)\b/,
    /\b(that|this|it).{0,30}(we|I|you).{0,30}(did|made|created|changed|working)\b/i,
    /\b(之前|上次|之前的|之前做的|那个项目|继续之前|回顾)\b/,
    /\b(我之前|我上次|我们之前|它之前|那个文件|那行代码|继续做)\b/,
    /\b(我做了什么|我在做什么|做了什么东西|接着之前)\b/,
  ]

  for (const p of patterns) {
    if (p.test(text)) return getText(parts)
  }

  if (
    text.length < 50 &&
    /\b(this|that|it|这里|那里|这个|那个|它|那)\b/.test(text) &&
    !/\b(是什么|怎么|help me|what is)\b/.test(text)
  ) {
    return getText(parts)
  }

  return null
}

/**
 * Find the start index of the current turn in the messages array.
 */
function findCurrentTurnStart(messages: any[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (getRole(messages[i]) === "user") return i
  }
  return messages.length
}

// ─── Plugin hook ─────────────────────────────────────────────────────────────

export const TransformPlugin = () => ({
  "experimental.chat.messages.transform": async (_input: any, output: any) => {
    if (!output?.messages || !Array.isArray(output.messages)) return

    const messages = output.messages
    if (messages.length === 0) return

    const currentTurnStart = findCurrentTurnStart(messages)

    // ── Step 1: Sync compression ─────────────────────────────────────────────
    try {
      const response = await fetch(SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          messages,
        }),
      })

      if (response.ok) {
        const data = (await response.json()) as SyncResponse

        if (data.messages && data.messages.length > 0) {
          // Server returns the compressed full message history
          output.messages.splice(0, output.messages.length, ...data.messages)
        }
      }
    } catch (err) {
      console.error(`[TransformPlugin] Sync failed:`, err)
    }

    // ── Step 2: Inject relevant history ─────────────────────────────────────
    const currentMsg = messages[messages.length - 1]
    if (!currentMsg || getRole(currentMsg) !== "user") return

    const query = detectHistoryQuery(currentMsg.parts || [])
    if (!query) return

    try {
      const searchRes = await fetch(
        `${SERVER_SEARCH_URL}/${encodeURIComponent(SESSION_ID)}?q=${encodeURIComponent(query)}&limit=3`,
        { headers: { "Content-Type": "application/json" } }
      )

      if (!searchRes.ok) {
        console.error(`[TransformPlugin] Search failed: ${searchRes.status}`)
        return
      }

      const searchData = await searchRes.json()

      if (searchData.count === 0) {
        console.log(`[TransformPlugin] No matches for: "${query.slice(0, 60)}"`)
        return
      }

      const injected: any[] = []
      for (const match of searchData.matches) {
        if (match.isCurrent) continue

        const s = match.summary
        const summaryLine = s
          ? `[Turn ${match.turnIndex}] ${s.overview || ""}${s.intent ? ` | Intent: ${s.intent}` : ""}${s.outcome ? ` | ${s.outcome}` : ""}`
          : `[Turn ${match.turnIndex}] (no summary)`

        injected.push({
          role: "system",
          info: { role: "system", __transformInjected: true },
          parts: [
            {
              type: "text",
              text: `=== Historical Context ===\n${summaryLine}\n\nOriginal messages:\n${JSON.stringify(match.messages, null, 2)}`,
            },
          ],
        })
      }

      const insertAt = findCurrentTurnStart(output.messages)
      output.messages.splice(insertAt, 0, ...injected)

      console.log(
        `[TransformPlugin] Injected ${injected.length} history blocks for: "${query.slice(0, 60)}"`
      )
    } catch (err) {
      console.error(`[TransformPlugin] History injection failed:`, err)
    }
  },
})

export default TransformPlugin
