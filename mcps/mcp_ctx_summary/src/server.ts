/**
 * Summary MCP Server — mcp_ctx_summary
 *
 * Provides retrieval tools over the shared summaries database
 * (summaries.db), populated by ctx_plugin's transform.ts plugin.
 *
 * Schema: @context-forge/shared-types/schema
 *
 * Tools:
 *   summary_recall    - Intent-driven recall with LLM generation
 *   summary_search    - FTS5 full-text search across turn summaries
 *   summary_list      - List all summaries for a session
 *   summary_get       - Get a single turn summary by index
 *   summary_messages  - Get raw messages for a turn
 *   summary_health    - Health check + DB stats
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { existsSync, statSync } from "fs"
import Database from "better-sqlite3"
import type { RecallOptions, RecallResult, StoredMessage, SummaryWithSession, TurnSummary } from "@context-forge/shared-types"
import { buildRecallPrompt } from "./recall-prompts.js"
import { createRecallLLMClient } from "./llm.js"
import { getDbPath } from "./config.js"

interface SummaryRow {
  turn_index: number
  overview: string
  intent: string
  actions_json: string
  artifacts_json: string
  outcome: string
  errors_json: string
  todos_json: string
  confidence: number
  reason: string | null
  generated_at: number
  tokens_used: number
  start_msg_id: string
  end_msg_id: string
}

interface MessageRow {
  msg_id: string
  session_id: string
  turn_index: number
  role: string
  content: string
  tool_calls: string | null
  created_at: number
  seq_in_turn: number
}

let db: any = null

function openDb(): any {
  if (db) return db
  const path = getDbPath()
  if (!existsSync(path)) {
    throw new Error(`Database not found at ${path}. Enable the transform plugin in ctx_plugin first.`)
  }
  db = new Database(path, { readonly: true })
  db.pragma("journal_mode = WAL")
  return db
}

function rowToSummary(row: SummaryRow): TurnSummary {
  return {
    turnIndex: row.turn_index,
    overview: row.overview,
    intent: row.intent,
    actions: JSON.parse(row.actions_json),
    artifacts: JSON.parse(row.artifacts_json),
    outcome: row.outcome as TurnSummary["outcome"],
    errors: JSON.parse(row.errors_json),
    todos: JSON.parse(row.todos_json),
    confidence: row.confidence,
    reason: row.reason || undefined,
    generatedAt: row.generated_at,
    tokensUsed: row.tokens_used,
    startMsgId: row.start_msg_id,
    endMsgId: row.end_msg_id,
  }
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    msgId: row.msg_id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    role: row.role as "user" | "assistant" | "tool",
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    createdAt: row.created_at,
    seqInTurn: row.seq_in_turn,
  }
}

interface SummaryRowWithSession extends SummaryRow {
  session_id: string
  turn_index: number
}

function searchSummaries(query: string, limit: number, sessionId?: string): SummaryWithSession[] {
  const database = openDb()
  const escaped = query
    .replace(/['"*()\-:^~]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" ")

  if (!escaped.trim()) {
    return listBySession(sessionId || "%")
  }

  let rows: SummaryRowWithSession[] = []

  try {
    let stmt: any
    if (sessionId) {
      stmt = database.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        JOIN summaries_fts f ON c.rowid = f.rowid
        WHERE idx.session_id = ? AND summaries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      rows = stmt.all(sessionId, escaped, limit)
    } else {
      stmt = database.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        JOIN summaries_fts f ON c.rowid = f.rowid
        WHERE summaries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
      rows = stmt.all(escaped, limit)
    }
    if (rows.length > 0) {
      return rows.map(rowToSummaryWithSession)
    }
  } catch {
    // FTS error — fall through to LIKE
  }

  const escapedQuery = query.replace(/[%_]/g, "\\$&")
  const likePattern = `%${escapedQuery}%`
  let sql: string
  if (sessionId) {
    sql = `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
           JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
           WHERE idx.session_id = ? AND (c.intent LIKE ? OR c.overview LIKE ?)
           ORDER BY c.generated_at DESC LIMIT ?`
    rows = database.prepare(sql).all(sessionId, likePattern, likePattern, limit)
  } else {
    sql = `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
           JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
           WHERE c.intent LIKE ? OR c.overview LIKE ?
           ORDER BY c.generated_at DESC LIMIT ?`
    rows = database.prepare(sql).all(likePattern, likePattern, limit)
  }
  return rows.map(rowToSummaryWithSession)
}

function rowToSummaryWithSession(row: SummaryRowWithSession): SummaryWithSession {
  return { ...rowToSummary(row), sessionId: row.session_id }
}

function listBySession(sessionId: string): SummaryWithSession[] {
  const database = openDb()
  let rows: SummaryRowWithSession[]
  if (sessionId === "%") {
    rows = database.prepare(`
      SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
      JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
      ORDER BY c.generated_at DESC LIMIT 50
    `).all()
  } else {
    rows = database.prepare(`
      SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
      JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
      WHERE idx.session_id = ?
      ORDER BY idx.turn_index ASC
    `).all(sessionId)
  }
  return rows.map(rowToSummaryWithSession)
}

function getSummary(sessionId: string, turnIndex: number): TurnSummary | null {
  const database = openDb()
  const row = database.prepare(`
    SELECT c.* FROM global_summary_cache c
    JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
    WHERE idx.session_id = ? AND idx.turn_index = ?
  `).get(sessionId, turnIndex) as SummaryRow | undefined
  return row ? rowToSummary(row) : null
}

function getMessages(sessionId: string, turnIndex: number): StoredMessage[] {
  const database = openDb()
  const rows = database.prepare(`
    SELECT * FROM turn_messages
    WHERE session_id = ? AND turn_index = ?
    ORDER BY seq_in_turn ASC
  `).all(sessionId, turnIndex) as MessageRow[]
  return rows.map(rowToMessage)
}

function getMessagesByRange(startMsgId: string, endMsgId: string): StoredMessage[] {
  const database = openDb()
  const rows = database.prepare(`
    SELECT * FROM turn_messages
    WHERE msg_id >= ? AND msg_id <= ?
    ORDER BY seq_in_turn ASC
  `).all(startMsgId, endMsgId) as MessageRow[]
  return rows.map(rowToMessage)
}

function getStats() {
  const database = openDb()
  const cacheRow = database.prepare(`SELECT COUNT(*) as c FROM global_summary_cache`).get() as any
  const sessionRow = database.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM session_turn_summaries`).get() as any
  const msgRow = database.prepare(`SELECT COUNT(*) as c FROM turn_messages`).get() as any
  const dbPath = getDbPath()
  const size = existsSync(dbPath) ? statSync(dbPath).size : 0
  return { totalSummaries: cacheRow.c, totalSessions: sessionRow.c, totalMessages: msgRow.c, dbSizeBytes: size }
}

const recallLLM = createRecallLLMClient()

async function performRecall(options: RecallOptions): Promise<RecallResult> {
  const { query, sessionId, limit = 3 } = options
  const summaries = searchSummaries(query, limit, sessionId)
  if (summaries.length === 0) {
    return { query, totalFound: 0, recalls: [] }
  }

  const recalls: RecallResult["recalls"] = []
  for (const summary of summaries) {
    const effectiveSessionId = summary.sessionId || sessionId
    const messages = effectiveSessionId
      ? getMessages(effectiveSessionId, summary.turnIndex)
      : []

    if (messages.length === 0) {
      if (summary.startMsgId && summary.endMsgId) {
        const rangeMessages = getMessagesByRange(summary.startMsgId, summary.endMsgId)
        if (rangeMessages.length > 0) {
          const recall = await generateRecall(query, summary, rangeMessages)
          recalls.push({
            turnIndex: summary.turnIndex,
            sessionId: summary.sessionId || sessionId || "",
            overview: summary.overview,
            intent: summary.intent,
            outcome: summary.outcome,
            confidence: summary.confidence,
            recall,
          })
        }
      }
    } else {
      const recall = await generateRecall(query, summary, messages)
      recalls.push({
        turnIndex: summary.turnIndex,
        sessionId: summary.sessionId || sessionId || "",
        overview: summary.overview,
        intent: summary.intent,
        outcome: summary.outcome,
        confidence: summary.confidence,
        recall,
      })
    }
  }
  return { query, totalFound: recalls.length, recalls }
}

async function generateRecall(query: string, summary: SummaryWithSession, messages: StoredMessage[]): Promise<string> {
  if (!recallLLM) {
    return `LLM not available. Raw messages:\n\n${messages.map(m => `[${m.role}] ${m.content.slice(0, 200)}`).join("\n\n")}`
  }
  try {
    const prompt = buildRecallPrompt({ query, summary, messages })
    const recall = await recallLLM.generate(prompt)
    return recall.trim()
  } catch (err) {
    console.error("[recall] LLM error:", err)
    return `Recall generation failed: ${err instanceof Error ? err.message : String(err)}`
  }
}

const server = new McpServer(
  { name: "mcp_ctx_summary", version: "0.3.0" },
  { capabilities: { tools: {} } },
)

const RecallSchema = z.object({
  query: z.string().describe("Natural language query for recall"),
  sessionId: z.string().optional().describe("Filter by session ID"),
  limit: z.number().optional().default(3).describe("Max results to return"),
})

const SearchSchema = z.object({
  query: z.string().describe("Search query for full-text search across summaries"),
  limit: z.number().optional().default(5).describe("Max results to return"),
  sessionId: z.string().optional().describe("Filter by session ID"),
})

const ListSchema = z.object({ sessionId: z.string().describe("Session ID to list summaries for") })
const GetSchema = z.object({ sessionId: z.string().describe("Session ID"), turnIndex: z.number().describe("Turn index") })
const MessagesSchema = z.object({ sessionId: z.string().describe("Session ID"), turnIndex: z.number().describe("Turn index") })

server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "summary_recall",
      description: "Intent-driven recall that retrieves relevant historical information. Uses LLM to generate context-aware recall based on a natural language query.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "Natural language query for recall" }, sessionId: { type: "string", description: "Filter by session ID" }, limit: { type: "number", description: "Max results to return", default: 3 } }, required: ["query"] },
    },
    {
      name: "summary_search",
      description: "Full-text search across all turn summaries.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", default: 5 }, sessionId: { type: "string" } }, required: ["query"] },
    },
    {
      name: "summary_list",
      description: "List all summaries for a specific session in turn order",
      inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
    },
    {
      name: "summary_get",
      description: "Get a single turn summary by session ID and turn index",
      inputSchema: { type: "object", properties: { sessionId: { type: "string" }, turnIndex: { type: "number" } }, required: ["sessionId", "turnIndex"] },
    },
    {
      name: "summary_messages",
      description: "Get raw messages for a specific turn",
      inputSchema: { type: "object", properties: { sessionId: { type: "string" }, turnIndex: { type: "number" } }, required: ["sessionId", "turnIndex"] },
    },
    {
      name: "summary_health",
      description: "Health check and database statistics",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}))

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    if (name === "summary_recall") {
      const { query, sessionId, limit = 3 } = RecallSchema.parse(args)
      const result = await performRecall({ query, sessionId, limit })
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }
    }
    if (name === "summary_search") {
      const { query, limit = 5, sessionId } = SearchSchema.parse(args)
      const results = searchSummaries(query, limit, sessionId)
      return { content: [{ type: "text", text: JSON.stringify({ query, count: results.length, results }, null, 2) }] }
    }
    if (name === "summary_list") {
      const { sessionId } = ListSchema.parse(args)
      const results = listBySession(sessionId)
      return { content: [{ type: "text", text: JSON.stringify({ sessionId, count: results.length, results }, null, 2) }] }
    }
    if (name === "summary_get") {
      const { sessionId, turnIndex } = GetSchema.parse(args)
      const summary = getSummary(sessionId, turnIndex)
      if (!summary) return { content: [{ type: "text", text: `Summary not found: session=${sessionId} turn=${turnIndex}` }], isError: true }
      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] }
    }
    if (name === "summary_messages") {
      const { sessionId, turnIndex } = MessagesSchema.parse(args)
      const messages = getMessages(sessionId, turnIndex)
      return { content: [{ type: "text", text: JSON.stringify({ sessionId, turnIndex, count: messages.length, messages }, null, 2) }] }
    }
    if (name === "summary_health") {
      try {
        const stats = getStats()
        return { content: [{ type: "text", text: JSON.stringify({ status: "ok", ...stats, recallEnabled: !!recallLLM }, null, 2) }] }
      } catch (err) {
        return { content: [{ type: "text", text: `DB not ready: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }
    }
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }
})

async function main() {
  console.error("[mcp_ctx_summary] Starting...")
  console.error(`[mcp_ctx_summary] DB path: ${getDbPath()}`)
  console.error(`[mcp_ctx_summary] Recall LLM: ${recallLLM ? "enabled" : "disabled (no API key)"}`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[mcp_ctx_summary] Connected")
}

main().catch((err) => {
  console.error("[mcp_ctx_summary] Fatal:", err)
  process.exit(1)
})
