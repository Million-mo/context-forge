/**
 * 测试 summary-mcp 的 recall 功能
 * 直接调用函数，不走 MCP 协议
 */

import { resolve } from "path"
import Database from "better-sqlite3"
import { buildRecallPrompt } from "./prompts.js"
import { RecallLLMClient } from "./llm.js"
import { config } from "./config.js"

// ─── Types ─────────────────────────────────────────────────────────────────────

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

interface SummaryRowWithSession extends SummaryRow {
  session_id: string
  turn_index: number
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

interface StoredMessage {
  msgId: string
  sessionId: string
  turnIndex: number
  role: "user" | "assistant" | "tool"
  content: string
  toolCalls?: { name: string; input: string; output?: string }[]
  createdAt: number
  seqInTurn: number
}

interface TurnSummary {
  turnIndex: number
  overview: string
  intent: string
  actions: any[]
  artifacts: any[]
  outcome: "success" | "partial" | "failure" | "unknown"
  errors: string[]
  todos: string[]
  confidence: number
  reason?: string
  generatedAt: number
  tokensUsed?: number
  startMsgId: string
  endMsgId: string
}

interface SummaryWithSession extends TurnSummary {
  sessionId: string
}

// ─── DB ───────────────────────────────────────────────────────────────────────

function getDbPath(): string {
  return resolve(process.cwd(), "data", "summaries.db")
}

function openDb(): Database.Database {
  const db = new Database(getDbPath(), { readonly: true })
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

function rowToSummaryWithSession(row: SummaryRowWithSession): SummaryWithSession {
  return {
    ...rowToSummary(row),
    turnIndex: row.turn_index,
    sessionId: row.session_id,
  }
}

// ─── Query Functions ───────────────────────────────────────────────────────────

function searchSummaries(query: string, limit = 5): SummaryWithSession[] {
  const db = openDb()

  const escaped = query
    .replace(/['"*()\-:^~]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" ")

  if (!escaped.trim()) {
    return []
  }

  let rows: SummaryRowWithSession[] = []

  // Try FTS first
  try {
    console.log("Trying FTS with query:", escaped)
    const stmt = db.prepare(`
      SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
      JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
      JOIN summaries_fts f ON c.rowid = f.rowid
      WHERE summaries_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `)
    rows = stmt.all(escaped, limit) as SummaryRowWithSession[]

    // If FTS returned results, return them
    if (rows.length > 0) {
      console.log("FTS found:", rows.length, "rows")
      return rows.map(rowToSummaryWithSession)
    }
  } catch (err) {
    console.log("FTS error:", err)
  }

  // FTS failed or no results — try LIKE fallback
  console.log("Trying LIKE fallback...")
  const likePattern = `%${query}%`
  const sql = `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
               JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
               WHERE c.intent LIKE ? OR c.overview LIKE ?
               ORDER BY c.generated_at DESC LIMIT ?`
  rows = db.prepare(sql).all(likePattern, likePattern, limit) as SummaryRowWithSession[]
  console.log("LIKE found:", rows.length, "rows")

  return rows.map(rowToSummaryWithSession)
}

function getMessages(sessionId: string, turnIndex: number): StoredMessage[] {
  const db = openDb()
  const rows = db.prepare(`
    SELECT * FROM turn_messages
    WHERE session_id = ? AND turn_index = ?
    ORDER BY seq_in_turn ASC
  `).all(sessionId, turnIndex) as MessageRow[]
  return rows.map(rowToMessage)
}

function getStats() {
  const db = openDb()
  const cacheRow = db.prepare("SELECT COUNT(*) as c FROM global_summary_cache").get() as any
  const msgRow = db.prepare("SELECT COUNT(*) as c FROM turn_messages").get() as any
  const sessionRow = db.prepare("SELECT COUNT(DISTINCT session_id) as c FROM session_turn_summaries").get() as any
  return { summaries: cacheRow.c, messages: msgRow.c, sessions: sessionRow.c }
}

// ─── Recall ───────────────────────────────────────────────────────────────────

async function performRecall(query: string, limit = 3) {
  console.log(`\n🔍 Query: "${query}"\n`)

  // Step 1: Search
  const summaries = searchSummaries(query, limit)
  console.log(`📊 Found ${summaries.length} matching summaries\n`)

  if (summaries.length === 0) {
    console.log("No summaries found. Try a different query.")
    return
  }

  // Step 2: Generate recall for each
  const llm = new RecallLLMClient({
    provider: config.llm.provider,
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    maxTokens: config.llm.maxTokens,
    temperature: config.llm.temperature,
  })

  for (const summary of summaries) {
    console.log("─".repeat(60))
    console.log(`📋 Turn ${summary.turnIndex} | Session: ${summary.sessionId.slice(0, 8)}...`)
    console.log(`   Intent: ${summary.intent}`)
    console.log(`   Outcome: ${summary.outcome}`)
    console.log(`   Confidence: ${summary.confidence}`)

    const messages = getMessages(summary.sessionId, summary.turnIndex)
    console.log(`   Messages: ${messages.length}`)

    if (messages.length === 0) {
      console.log("   ⚠️  No messages found for this turn")
      continue
    }

    // Build prompt and show it
    const prompt = buildRecallPrompt({ query, summary, messages })
    console.log("\n📝 Prompt preview (first 500 chars):")
    console.log("─".repeat(40))
    console.log(prompt.slice(0, 500) + "...")
    console.log("─".repeat(40))

    // Call LLM
    console.log("\n🤖 Calling LLM...")
    try {
      const recall = await llm.generate(prompt)
      console.log("\n✨ Recall result:")
      console.log(recall)
    } catch (err) {
      console.log(`\n❌ LLM error: ${err}`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🧪 Summary MCP Recall Test\n")

  const query = process.argv[2] || "bug"
  
  // Show stats
  try {
    const stats = getStats()
    console.log(`📊 DB Stats: ${stats.summaries} summaries, ${stats.messages} messages, ${stats.sessions} sessions\n`)
  } catch (err) {
    console.log(`❌ Cannot open DB: ${err}`)
    console.log("Make sure transform-server has been run first to create the database.")
    return
  }

  await performRecall(query)
}

main().catch(console.error)
