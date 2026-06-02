/**
 * OpenCode Plugin: Transform messages via local compression
 *
 * Embeds all compression logic directly in the plugin — no external server needed.
 *
 * Architecture:
 * - Compression: pure functions (splitIntoTurns, decay scoring, message replacement)
 * - Persistence: SQLite via node:sqlite
 * - LLM summarization: async, non-blocking
 * - Hook: experimental.chat.messages.transform (fires with full message history)
 *
 * Environment variables:
 *   CONTEXT_FORGE_LLM_API_KEY   (or TRANSFORM_LLM_API_KEY legacy)
 *   CONTEXT_FORGE_LLM_BASE_URL  (or TRANSFORM_LLM_BASE_URL legacy)
 *   CONTEXT_FORGE_LLM_MODEL     (or TRANSFORM_LLM_MODEL legacy)
 *   TRANSFORM_DATA_DIR  - defaults to <workspace>/ctx_plugin/transform-data
 */

// ─── Imports ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { mkdirSync, appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { tool } from "@opencode-ai/plugin"
import type { TurnSummary } from "@context-forge/shared-types"

// ─── Session DB (inlined — plugin must be self-contained, no external imports) ─
// Schema mirrors the Node.js version in mcp_context_forge/src/services.ts.

type SessionDb = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number }
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

function resolveDataDir(): string {
  return resolve(process.cwd(), ".ctx_plugin")
}

function resolveSessionDbPath(): string {
  const sessionsDir = resolve(resolveDataDir(), "sessions")
  const hash = createHash("sha256").update(process.cwd().toLowerCase()).digest("hex").slice(0, 16)
  return resolve(sessionsDir, `${hash}.db`)
}

const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  project_dir TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  compact_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 3,
  data TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  bytes_avoided INTEGER NOT NULL DEFAULT 0,
  bytes_returned INTEGER NOT NULL DEFAULT 0,
  project_dir TEXT NOT NULL DEFAULT '',
  source_hook TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(session_id, category);
CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT NOT NULL, tool TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  bytes_returned INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tool)
);
CREATE TABLE IF NOT EXISTS session_resume (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL, event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), consumed INTEGER NOT NULL DEFAULT 0
);
`

let _sdb: SessionDb | null = null

function getSessionDb(): SessionDb {
  if (_sdb) return _sdb
  const { Database } = require("bun:sqlite") as { Database: new (path: string) => SessionDb }
  const dir = resolve(resolveDataDir(), "sessions")
  mkdirSync(dir, { recursive: true })
  _sdb = new Database(resolveSessionDbPath())
  _sdb.exec("PRAGMA journal_mode = DELETE")
  _sdb.exec("PRAGMA synchronous = NORMAL")
  _sdb.exec(SESSION_SCHEMA)
  return _sdb
}

function sEnsureSession(sessionId: string, projectDir: string): void {
  getSessionDb().prepare(`INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`).run(sessionId, projectDir)
}

function sInsertSessionEvent(ev: {
  session_id: string; type: string; category?: string; priority?: number;
  data?: string; tool?: string; args?: string; result?: string;
  bytes_avoided?: number; bytes_returned?: number; project_dir?: string; source_hook?: string;
}): void {
  const db = getSessionDb()
  sEnsureSession(ev.session_id, ev.project_dir ?? "")
  db.prepare(`UPDATE sessions SET last_event_at = datetime('now'), event_count = event_count + 1 WHERE session_id = ?`).run(ev.session_id)
  db.prepare(
    `INSERT INTO events (session_id, type, category, priority, data, tool, args, result, bytes_avoided, bytes_returned, project_dir, source_hook)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ev.session_id, ev.type, ev.category ?? "", ev.priority ?? 3,
    ev.data ?? "", ev.tool ?? "", ev.args ?? "", ev.result ?? "",
    ev.bytes_avoided ?? 0, ev.bytes_returned ?? 0, ev.project_dir ?? "", ev.source_hook ?? ""
  )
}

function sGetSessionEvents(sessionId: string, opts?: { type?: string; category?: string; limit?: number }): any[] {
  const db = getSessionDb()
  const limit = opts?.limit ?? 100
  if (opts?.type) return db.prepare(`SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`).all(sessionId, opts.type, limit)
  if (opts?.category) return db.prepare(`SELECT * FROM events WHERE session_id = ? AND category = ? ORDER BY id ASC LIMIT ?`).all(sessionId, opts.category, limit)
  return db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?`).all(sessionId, limit)
}

function sGetSessionMeta(sessionId: string): any | null {
  try { return getSessionDb().prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as any ?? null }
  catch { return null }
}

function sGetEventCount(sessionId: string): number {
  try { const r = getSessionDb().prepare(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined; return r?.cnt ?? 0 }
  catch { return 0 }
}

function sIncrementCompactCount(sessionId: string): void {
  getSessionDb().prepare(`UPDATE sessions SET compact_count = compact_count + 1 WHERE session_id = ?`).run(sessionId)
}

function sUpsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
  getSessionDb().prepare(
    `INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET snapshot=excluded.snapshot, event_count=excluded.event_count, created_at=datetime('now'), consumed=0`
  ).run(sessionId, snapshot, eventCount ?? 0)
}

function sGetToolCallStats(sessionId: string): { totalCalls: number; totalBytesReturned: number; byTool: Record<string, { calls: number; bytesReturned: number }> } {
  try {
    const db = getSessionDb()
    const totals = db.prepare(`SELECT COALESCE(SUM(calls),0) as calls, COALESCE(SUM(bytes_returned),0) as br FROM tool_calls WHERE session_id = ?`).get(sessionId) as { calls: number; br: number } | undefined
    const rows = db.prepare(`SELECT tool, calls, bytes_returned FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`).all(sessionId) as Array<{ tool: string; calls: number; bytes_returned: number }>
    const byTool: Record<string, { calls: number; bytesReturned: number }> = {}
    for (const r of rows) byTool[r.tool] = { calls: r.calls, bytesReturned: r.bytes_returned }
    return { totalCalls: totals?.calls ?? 0, totalBytesReturned: totals?.br ?? 0, byTool }
  } catch { return { totalCalls: 0, totalBytesReturned: 0, byTool: {} } }
}

function sTrackToolCall(sessionId: string, tool: string, bytesReturned: number): void {
  getSessionDb().prepare(
    `INSERT INTO tool_calls (session_id, tool, calls, bytes_returned, updated_at) VALUES (?, ?, 1, ?, datetime('now'))
     ON CONFLICT(session_id, tool) DO UPDATE SET calls=calls+1, bytes_returned=bytes_returned+excluded.bytes_returned, updated_at=datetime('now')`
  ).run(sessionId, tool, bytesReturned)
}

// ─── Bun SQLite Infrastructure ────────────────────────────────────────────────
// OpenCode runs on Bun, which bundles bun:sqlite (native FTS5).
// Adapt bun:sqlite API to the same interface used in transform.ts.

// NOTE: DB paths must match @context-forge/shared-types/paths.ts exactly.
// transform plugin writes summaries.db; MCP server reads from it.
// Both must use process.cwd() so they share the same location for the same project.
// summaries.db lives at: <cwd>/.ctx_plugin/data/summaries.db
// sessions.db lives at: <cwd>/.ctx_plugin/sessions/<hash>.db

function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  )
}

function renameCorruptDB(dbPath: string): void {
  const { renameSync } = require("node:fs")
  const ts = Date.now()
  try { renameSync(dbPath, `${dbPath}.corrupt-${ts}`) } catch { /* ok */ }
}

function applyPragmas(db: any): void {
  db.exec("PRAGMA journal_mode = DELETE")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA mmap_size = 268435456")
}

function openDatabase(dbPath: string): any {
  const { Database } = require("bun:sqlite")
  let db: any
  try {
    db = new Database(dbPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isSQLiteCorruptionError(msg)) {
      renameCorruptDB(dbPath)
      db = new Database(dbPath)
    } else {
      throw err
    }
  }
  applyPragmas(db)
  return db
}

const _liveDBs = new Set<any>()
process.on("exit", () => {
  for (const db of _liveDBs) {
    try { db.close() } catch { /* ok */ }
  }
  _liveDBs.clear()
})

function registerDB(db: any): void { _liveDBs.add(db) }

// ─── Types ─────────────────────────────────────────────────────────────────

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

interface ToolOutputEntry {
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
  contentHash: string
  summaryStatus: "pending" | "generating" | "done" | "unavailable"
  summary?: TurnSummary
}

interface SessionStore {
  source: any[]
  turns: Turn[]
  toolOutputs: Map<string, ToolOutputEntry>
}

// ─── Config ─────────────────────────────────────────────────────────────────

// NOTE: summaries.db path must match @context-forge/shared-types/paths.ts getSummariesDbPath().
// Both use process.cwd() so they share the same location for the same project.
// summaries.db lives at: <cwd>/.ctx_plugin/data/summaries.db
function getSummariesDbPathInline(): string {
  return resolve(process.cwd(), ".ctx_plugin", "data", "summaries.db")
}

const DATA_DIR = process.env.TRANSFORM_DATA_DIR
  || resolve(process.cwd(), ".ctx_plugin", "data")

const LOG_DIR = resolve(process.cwd(), ".ctx_plugin", "log")
const LOG_FILE = resolve(LOG_DIR, "transform.log")

function ensureLogDir() {
  try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
}

let _logFileReady = false
function writeLog(level: string, ...parts: string[]) {
  if (!_logFileReady) { ensureLogDir(); _logFileReady = true }
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "")
  const line = `${ts} [${level}] [Transform] ${parts.join(" ")}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
}

const log = {
  info:  (...a: string[]) => { writeLog("INFO",  ...a); _appLog?.("info",  a.join(" ")) },
  warn:  (...a: string[]) => { writeLog("WARN",  ...a); _appLog?.("warn",  a.join(" ")) },
  error: (...a: string[]) => { writeLog("ERROR", ...a); _appLog?.("error", a.join(" ")) },
}
let _appLog: ((level: string, msg: string) => void) | null = null
function initAppLogger(client: any) {
  _appLog = (level, msg) => {
    try {
      client.app.log({ body: { service: "Transform", level, message: msg } })
    } catch { /* file log already done above */ }
  }
}

const TOKEN_BUDGET = 8000
const MAX_HOT_TURNS = 5

const DECAY_WEIGHTS = {
  distance: 1.0,
  time: 0.3,
  frequency: 0.5,
}

const TOOL_DECAY_MODIFIERS: Record<string, number> = {
  read: 0.8,
  glob: 0.6,
  grep: 0.7,
  webfetch: 1.5,
}

const CACHEABLE_TOOLS: Set<string> = new Set([
  "read", "glob", "grep", "webfetch",
])

const SESSION_ID = process.env.SESSION_ID || "default"

// ─── LLM Config ─────────────────────────────────────────────────────────────

function getCtxPluginGlobalDir(): string {
  if (process.env.CTX_PLUGIN_CONFIG_DIR) return process.env.CTX_PLUGIN_CONFIG_DIR
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA || resolve(process.env.HOME || "", "AppData", "Roaming"), "ctx_plugin")
  }
  return resolve(process.env.HOME || "", ".ctx_plugin")
}

function loadLLMConfigFromFile() {
  // Priority: project .ctx_plugin/config.json > project config.json (legacy) > global ~/.ctx_plugin/config.json
  const candidates = [
    resolve(process.cwd(), ".ctx_plugin", "config.json"),
    resolve(process.cwd(), "config.json"),
    resolve(getCtxPluginGlobalDir(), "config.json"),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const cfg = JSON.parse(readFileSync(path, "utf-8"))
      if (cfg.llm?.apiKey || cfg.apiKey) {
        return {
          apiKey: cfg.llm?.apiKey || cfg.apiKey || undefined,
          baseUrl: cfg.llm?.baseUrl || cfg.baseUrl || undefined,
          model: cfg.llm?.model || cfg.model || undefined,
          maxTokens: cfg.llm?.maxTokens || cfg.maxTokens || undefined,
          temperature: cfg.llm?.temperature || cfg.temperature || undefined,
        }
      }
    } catch { /* try next */ }
  }
  return {}
}

const _fileConfig = loadLLMConfigFromFile()

const LLM_CONFIG = {
  apiKey: process.env.CONTEXT_FORGE_LLM_API_KEY || process.env.TRANSFORM_LLM_API_KEY || _fileConfig.apiKey || "placeholder",
  baseUrl: process.env.CONTEXT_FORGE_LLM_BASE_URL || process.env.TRANSFORM_LLM_BASE_URL || _fileConfig.baseUrl || "http://116.204.104.177:8123",
  model: process.env.CONTEXT_FORGE_LLM_MODEL || process.env.TRANSFORM_LLM_MODEL || _fileConfig.model || "GLM-4.7",
  maxTokens: _fileConfig.maxTokens ?? 2048,
  temperature: _fileConfig.temperature ?? 0.3,
}

function validateLLMConfig(): void {
  if (LLM_CONFIG.apiKey === "placeholder") {
    log.warn("LLM summarization DISABLED (no API key configured)")
    log.warn("Set CONTEXT_FORGE_LLM_API_KEY (+ CONTEXT_FORGE_LLM_BASE_URL) to enable turn summaries")
  }
}

// ─── SQLite Store ────────────────────────────────────────────────────────────

/**
 * Schema is injected at build time from @context-forge/shared-types/schema.
 * See bin/build-plugins.mjs — it replaces __CTX_SUMMARIES_SCHEMA__ with
 * the canonical SUMMARIES_DB_SCHEMA export.
 */
const SCHEMA = `__CTX_SUMMARIES_SCHEMA__`

class SummaryStore {
  private db: any

  constructor(db: any) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  getByHash(contentHash: string): TurnSummary | null {
    const stmt = this.db.prepare(
      "SELECT * FROM global_summary_cache WHERE content_hash = ?"
    )
    const row = stmt.get(contentHash)

    if (!row) return null

    this.db.prepare(
      "UPDATE global_summary_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE content_hash = ?"
    ).run(Date.now(), contentHash)

    return this.rowToSummary(row)
  }

  insert(summary: TurnSummary, sessionId: string, contentHash: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO global_summary_cache
        (content_hash, overview, intent, actions_json, artifacts_json,
         outcome, errors_json, todos_json, confidence, reason, generated_at,
         tokens_used, last_hit_at, start_msg_id, end_msg_id)
      VALUES
        (?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?)
    `).run(
      contentHash,
      summary.overview,
      summary.intent,
      JSON.stringify(summary.actions),
      JSON.stringify(summary.artifacts),
      summary.outcome,
      JSON.stringify(summary.errors),
      JSON.stringify(summary.todos),
      summary.confidence,
      summary.reason || null,
      summary.generatedAt,
      summary.tokensUsed || 0,
      Date.now(),
      summary.startMsgId,
      summary.endMsgId,
    )

    this.db.prepare(`
      INSERT OR REPLACE INTO session_turn_summaries
        (session_id, turn_index, content_hash)
      VALUES (?, ?, ?)
    `).run(sessionId, summary.turnIndex, contentHash)
  }

  insertMessages(sessionId: string, turnIndex: number, messages: any[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO turn_messages
        (msg_id, session_id, turn_index, role, content, tool_calls, created_at, seq_in_turn)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    for (let seq = 0; seq < messages.length; seq++) {
      const msg = messages[seq]
      const role = msg?.info?.role || msg?.role || "unknown"

      let textContent = ""
      const toolCalls: any[] = []

      for (const part of msg.parts || []) {
        if (part.type === "text") {
          textContent += (part.text || "").trim()
        } else if (part.type === "tool") {
          const state = part.state || {}
          toolCalls.push({
            name: part.tool || "unknown",
            input: JSON.stringify(state.input || {}),
            output: (state.output || "").toString(),
          })
        }
      }

      stmt.run(
        `${sessionId}-turn${turnIndex}-seq${seq}`,
        sessionId,
        turnIndex,
        role,
        textContent,
        toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        msg?.timestamp || Date.now(),
        seq,
      )
    }
  }

  search(query: string, limit = 5): TurnSummary[] {
    if (!query.trim()) return []

    const safe = query.replace(/[^a-zA-Z0-9\u4e00-\u9fff\s]/g, " ").trim()
    if (!safe || safe.length > 200) return []

    const words = safe.split(/\s+/).filter(Boolean)
    if (words.length === 0) return []

    const ftsQuery = words.map((w: string) => `"${w.replace(/"/g, '""')}"`).join(" OR ")

    try {
      const stmt = this.db.prepare(`
        SELECT * FROM global_summary_cache
        WHERE content_hash IN (
          SELECT content_hash FROM summaries_fts WHERE summaries_fts MATCH ?
        )
        ORDER BY hit_count DESC, last_hit_at DESC
        LIMIT ?
      `)
      const rows = stmt.all(ftsQuery, limit)
      return rows.map((row: any) => this.rowToSummary(row))
    } catch (err) {
      log.warn("search failed:", String(err))
      return []
    }
  }

  listBySession(sessionId: string): any[] {
    try {
      const stmt = this.db.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index
        FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        WHERE idx.session_id = ?
        ORDER BY idx.turn_index ASC
      `)
      const rows = stmt.all(sessionId) as any[]
      return rows.map((row) => ({ ...this.rowToSummary(row), sessionId: row.session_id ?? sessionId }))
    } catch (err) {
      log.warn("listBySession failed:", String(err))
      return []
    }
  }

  getSummary(sessionId: string, turnIndex: number): any | null {
    try {
      const stmt = this.db.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        WHERE idx.session_id = ? AND idx.turn_index = ?
      `)
      const row = stmt.get(sessionId, turnIndex) as any
      if (!row) return null
      return { ...this.rowToSummary(row), sessionId: row.session_id ?? sessionId }
    } catch (err) {
      log.warn("getSummary failed:", String(err))
      return null
    }
  }

  getMessages(sessionId: string, turnIndex: number): Array<{
    msgId: string; sessionId: string; turnIndex: number;
    role: string; content: string; toolCalls?: unknown; createdAt: number; seqInTurn: number
  }> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM turn_messages
        WHERE session_id = ? AND turn_index = ?
        ORDER BY seq_in_turn ASC
      `)
      const rows = stmt.all(sessionId, turnIndex) as Array<any>
      return rows.map((r) => ({
        msgId: r.msg_id,
        sessionId: r.session_id,
        turnIndex: r.turn_index,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
        createdAt: r.created_at,
        seqInTurn: r.seq_in_turn,
      }))
    } catch (err) {
      log.warn("getMessages failed:", String(err))
      return []
    }
  }

  private rowToSummary(row: any): TurnSummary {
    return {
      turnIndex: row.turn_index ?? 0,
      overview: row.overview,
      intent: row.intent,
      actions: safeJsonParse(row.actions_json, []),
      artifacts: safeJsonParse(row.artifacts_json, []),
      outcome: row.outcome,
      errors: safeJsonParse(row.errors_json, []),
      todos: safeJsonParse(row.todos_json, []),
      confidence: row.confidence,
      reason: row.reason || undefined,
      generatedAt: row.generated_at,
      tokensUsed: row.tokens_used,
      startMsgId: row.start_msg_id,
      endMsgId: row.end_msg_id,
    }
  }
}


// Global store instance (initialized lazily — synchronous)
let store: SummaryStore | null = null
function getStore(): SummaryStore {
  if (!store) {
    const dbPath = getSummariesDbPathInline()
    const dir = dbPath.replace(/[^/\\]+$/, "")
    if (dir) mkdirSync(dir, { recursive: true })
    const db = openDatabase(dbPath)
    registerDB(db)
    store = new SummaryStore(db)
  }
  return store
}

const SUMMARY_SYSTEM_PROMPT = `你是一个上下文压缩助手。请从对话轮次中提取关键信息，生成结构化摘要。

重要：你没有思考能力，不要输出任何思考过程、推理步骤或解释。直接输出 JSON 结果。

输出要求：
- overview 控制在 20 字以内
- actions 只记录关键步骤，跳过纯探索性调用（read/grep/glob 等），除非结果有特别发现
- artifacts 优先记录 modified/created，read 类型除非有重要发现否则省略
- confidence 反映摘要可信度：对话清晰=0.9, 模糊或结果截断=0.5
- 如果 outcome 不是 success，必须填写 reason 字段

严格按以下 JSON 格式输出，不可省略任何字段：`

const SUMMARY_USER_PROMPT = `请为以下对话轮次生成摘要：

<turn_messages>
{turn_content}
</turn_messages>

按此 JSON 格式直接输出（不要包含任何其他内容、思考过程或解释）：
{
  "overview": "一句话描述本轮做了什么+结果",
  "intent": "用户的核心需求",
  "actions": [{"tool": "工具名", "target": "操作对象", "description": "动作", "result": "结果"}],
  "artifacts": [{"path": "文件路径", "action": "created|modified|deleted|read", "detail": "变更说明"}],
  "outcome": "success|partial|failure|unknown",
  "errors": ["错误描述"],
  "todos": ["未完成事项"],
  "confidence": 0.0-1.0,
  "reason": "当 outcome!=success 或 confidence<0.7 时的解释"
}`

function serializeMessages(messages: any[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    const role = msg?.info?.role || msg?.role || "unknown"
    lines.push(`[${role.toUpperCase()}]`)

    for (const part of msg.parts || []) {
      if (part.type === "text") {
        const text = (part.text || "").trim()
        if (text) lines.push(text)
      } else if (part.type === "tool") {
        const toolName = part.tool || "unknown"
        const state = part.state || {}
        const inputStr = JSON.stringify(state.input || {}, null, 2)
        const outputStr = (state.output || "").toString()

        lines.push(`--- tool_call: ${toolName}`)
        lines.push(`input: ${inputStr}`)

        const MAX_OUTPUT_LINES = 60
        const outputLines = outputStr.split("\n")
        if (outputLines.length > MAX_OUTPUT_LINES) {
          lines.push(
            `output (truncated, ${outputLines.length} lines):`,
            ...outputLines.slice(0, MAX_OUTPUT_LINES),
            `... [${outputLines.length - MAX_OUTPUT_LINES} more lines]`,
          )
        } else {
          lines.push(`output: ${outputStr || "(empty)"}`)
        }
        lines.push("---")
      }
    }
  }
  return lines.join("\n")
}

async function generateSummary(
  turnIndex: number,
  messages: any[],
  sessionId: string,
  contentHash: string,
): Promise<TurnSummary | null> {
  if (!LLM_CONFIG.apiKey || LLM_CONFIG.apiKey === "placeholder") {
    log.info(`No LLM API key — summary skipped for turn ${turnIndex}`)
    return null
  }

  const serializedContent = serializeMessages(messages).slice(0, MAX_SERIALIZED_SIZE)
  const requestMessages = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: SUMMARY_USER_PROMPT.replace("{turn_content}", serializedContent) },
  ]

  try {
    const url = `${LLM_CONFIG.baseUrl.replace(/\/$/, "")}/v1/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)

    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${LLM_CONFIG.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: LLM_CONFIG.model,
          messages: requestMessages,
          max_tokens: LLM_CONFIG.maxTokens,
          temperature: LLM_CONFIG.temperature,
        }),
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      log.error(`LLM API error ${res.status} for turn ${turnIndex}`)
      return null
    }

    const data = await Promise.race([
      res.json() as Promise<any>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM response JSON parse timeout")), 30_000)
      ),
    ])
    const raw = data.choices?.[0]?.message?.content || ""

    const parsed = parseLLMResponse(raw)
    const summary: TurnSummary = {
      turnIndex,
      overview: parsed.overview,
      intent: parsed.intent,
      actions: parsed.actions,
      artifacts: parsed.artifacts,
      outcome: parsed.outcome,
      errors: parsed.errors,
      todos: parsed.todos,
      confidence: parsed.confidence,
      reason: parsed.reason,
      generatedAt: Date.now(),
      tokensUsed: data.usage?.total_tokens || 0,
      startMsgId: `turn-${turnIndex}-start`,
      endMsgId: `turn-${turnIndex}-end`,
    }

    const db = await getStore()
    db.insert(summary, sessionId, contentHash)
    db.insertMessages(sessionId, turnIndex, messages)
    log.info(`Summary generated for turn ${turnIndex}: ${summary.overview}`)
    return summary
  } catch (err) {
    log.error(`LLM call failed for turn ${turnIndex}:`, String(err))
    return null
  }
}

function parseLLMResponse(raw: string): any {
  const defaultReturn = {
    overview: "(解析失败)",
    intent: "",
    actions: [],
    artifacts: [],
    outcome: "unknown",
    errors: [],
    todos: [],
    confidence: 0.1,
    reason: `LLM 返回格式无法解析: ${raw.slice(0, 200)}`,
  }

  const match = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/(\{[\s\S]*\})/)
  if (!match) return defaultReturn

  try {
    const parsed = JSON.parse(match[1])
    return {
      overview: String(parsed.overview || "").slice(0, 100),
      intent: String(parsed.intent || ""),
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      outcome: ["success", "partial", "failure", "unknown"].includes(parsed.outcome)
        ? parsed.outcome : "unknown",
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
      confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
      reason: parsed.reason,
    }
  } catch {
    return defaultReturn
  }
}

// ─── Compression Logic ──────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MAX_SERIALIZED_SIZE = 50_000

function deepClone<T>(obj: T): T {
  // Fast path for plain objects/arrays of primitives — avoids JSON roundtrip
  try {
    return structuredClone(obj) as T
  } catch {
    // structuredClone throws on circular refs or non-serializable values
    // Fall back to JSON roundtrip (handles circular by throwing)
    return JSON.parse(JSON.stringify(obj)) as T
  }
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

// Fast token estimator — avoids full JSON.stringify of every message on each call.
// Tokens ≈ chars / 4 is accurate enough for compression decisions.
function estimateTokens(messages: any[]): number {
  let total = 0
  for (const m of messages) {
    if (!m) continue
    // Use info + parts path for new format, role/parts for old format
    const parts = m.parts || []
    for (const p of parts) {
      if (typeof p?.text === "string") total += p.text.length
      else if (typeof p?.output === "string") total += p.output.length
      else if (typeof p === "string") total += p.length
    }
  }
  return Math.ceil(total / 4)
}

function getRole(msg: any): string {
  return msg?.info?.role || msg?.role || ""
}

// Fast hash for message deduplication — extracts only the meaningful content
// to avoid the cost of full JSON.stringify on large message arrays.
function hashMessages(messages: any[]): string {
  // Only hash role + text content — skip metadata, timestamps, tokens, etc.
  let input = ""
  for (const m of messages) {
    input += (m?.info?.role || m?.role || "") + "|"
    const parts = m?.parts || []
    for (const p of parts) {
      if (p?.type === "text") input += p.text ?? ""
      else if (p?.type === "tool") input += (p?.tool ?? "") + "|" + (p?.state?.input ? JSON.stringify(p.state.input) : "")
    }
    input += "\n"
  }
  return createHash("sha256").update(input).digest("hex")
}

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

function buildToolKey(prefix: string, primaryKey: string, primaryValue: string, input: Record<string, any>): string {
  const params = Object.entries(input)
    .filter(([k, v]) => k !== primaryKey && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`).sort().join(";")
  return params ? `${prefix}:${primaryValue};${params}` : `${prefix}:${primaryValue}`
}

function getToolOutputKey(toolName: string, state: any): string | null {
  const input = state?.input || {}
  const tool = toolName.toLowerCase()

  switch (tool) {
    case "read": {
      const filePath = input.filePath || input.file || input.path || ""
      const cleanInput = { ...input, filePath }
      delete cleanInput.file
      delete cleanInput.path
      return buildToolKey("file", "filePath", filePath, cleanInput)
    }
    case "grep":
      return buildToolKey("grep", "pattern", input.pattern || "", input)
    case "glob":
      return buildToolKey("glob", "pattern", input.pattern || "", input)
    case "webfetch":
      return buildToolKey("url", "url", input.url || "", input)
    default:
      return null
  }
}

function calculateDecayScore(entry: ToolOutputEntry, currentTurnIdx: number): number {
  const { distance: wDist, time: wTime, frequency: wFreq } = DECAY_WEIGHTS

  const turnDistance = currentTurnIdx - Math.floor(entry.lastSeenTurnIdx / 10)
  const distanceScore = Math.min(turnDistance / 3, 5)

  const timeAgeMinutes = (Date.now() - entry.timestamp) / 60000
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
        case "summary": return `[COMPRESSED: read "${filePath}"]\n${[
          ...lines.slice(0, 3),
          `  ... ${Math.max(0, lineCount - 6)} more lines ...`,
          ...lines.slice(-3),
        ].join("\n")}`
        case "placeholder": return `[COMPRESSED: read "${filePath}" — ${lineCount} lines]`
        case "minimal": return `[COMPRESSED: read "${filePath}"]`
      }
    }
    case "glob": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary": return `[COMPRESSED: glob "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(", ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder": return `[COMPRESSED: glob "${pattern}" — ${count} matches]`
        case "minimal": return `[COMPRESSED: glob "${pattern}"]`
      }
    }
    case "grep": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary": return `[COMPRESSED: grep "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(" | ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder": return `[COMPRESSED: grep "${pattern}" — ${count} matches]`
        case "minimal": return `[COMPRESSED: grep "${pattern}"]`
      }
    }
    case "webfetch": {
      const url = input.url || "?"
      const size = new TextEncoder().encode(output).length
      switch (level) {
        case "full": return output
        case "summary": return `[COMPRESSED: webfetch "${url}"]\n${output.slice(0, 200)}...`
        case "placeholder": return `[COMPRESSED: webfetch "${url}" — ${size} bytes]`
        case "minimal": return `[COMPRESSED: webfetch "${url}"]`
      }
    }
    default:
      return `[COMPRESSED: ${toolName} — output truncated]`
  }
}

function buildCompressedMessagesForHotTurn(
  turn: Turn,
  toolOutputs: Map<string, ToolOutputEntry>,
  currentTurnIdx: number,
): any[] {
  const result: any[] = []

  for (const msg of turn.messages) {
    const role = getRole(msg)
    if (role !== "assistant") {
      result.push(deepClone(msg))
      continue
    }

    const cloned = deepClone(msg)

    for (const part of cloned.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName: string = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue

      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue

      const entry = toolOutputs.get(key)
      if (!entry) continue

      const score = calculateDecayScore(entry, currentTurnIdx)
      const level = getCompressionLevel(score)
      if (level !== "full") {
        part.state.output = compressToolOutput(toolName, part.state, level)
      }
    }

    result.push(cloned)
  }

  return result
}

function buildSummaryReplacement(turn: Turn): any[] {
  const s = turn.summary
  const timestamp = new Date(turn.messages[0]?.timestamp ?? Date.now()).toLocaleString()

  return [
    {
      info: { role: "user", __compressed: "summary", turnIndex: turn.index },
      parts: [{
        type: "text",
        text: `=== Turn ${turn.index} Summary (${timestamp}) ===\nCompressed: ${turn.messageCount} msgs, ~${turn.tokenEstimate} tokens.`,
      }],
    },
    {
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
          : `(Summary not yet generated)`,
      }],
    },
  ]
}

function buildPlaceholderReplacement(turn: Turn): any[] {
  return [{
    info: { role: "user", __compressed: "placeholder", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: `=== Turn ${turn.index} (${turn.messageCount} msgs, ~${turn.tokenEstimate} tokens) ===\n[Compressed]`,
    }],
  }]
}

function buildCompressedMessages(
  turns: Turn[],
  toolOutputs: Map<string, ToolOutputEntry>,
): { messages: any[]; sourceTokens: number; compressedTokens: number; reduction: string } {
  const completedTurns = turns.filter((t) => !t.isCurrent)
  const currentTurn = turns.find((t) => t.isCurrent)

  const reservedForCurrent = currentTurn ? estimateTokens(currentTurn.messages) : 0
  const availableBudget = TOKEN_BUDGET - reservedForCurrent
  const sourceTokens = estimateTokens(turns.flatMap((t) => t.messages))

  if (availableBudget <= 0) {
    return {
      messages: currentTurn ? [...currentTurn.messages] : [],
      sourceTokens,
      compressedTokens: sourceTokens,
      reduction: "0%",
    }
  }

  const keptMessages: any[] = []
  const replacedTurns: Turn[] = []
  let usedTokens = 0

  for (const turn of [...completedTurns].reverse()) {
    const compressed = buildCompressedMessagesForHotTurn(turn, toolOutputs, turns.length)
    const tokens = estimateTokens(compressed)

    if (usedTokens + tokens <= availableBudget) {
      keptMessages.unshift(...compressed)
      usedTokens += tokens
    } else {
      replacedTurns.unshift(turn)
    }
  }

  const result: any[] = []
  for (const turn of replacedTurns) {
    if (turn.summaryStatus === "done" && turn.summary) {
      result.push(...buildSummaryReplacement(turn))
    } else {
      result.push(...buildPlaceholderReplacement(turn))
    }
  }

  result.push(...keptMessages)

  if (currentTurn) {
    result.push(...currentTurn.messages)
  }

  const compressedTokens = estimateTokens(result)
  const reduction = sourceTokens > 0
    ? `${((1 - compressedTokens / sourceTokens) * 100).toFixed(1)}%`
    : "0%"

  return { messages: result, sourceTokens, compressedTokens, reduction }
}

// ─── Session Store (in-memory) ───────────────────────────────────────────────

const sessions = new Map<string, SessionStore>()
const inFlightSummaries = new Set<string>()

const MAX_SESSION_AGE_MS = 30 * 60 * 1000 // 30 minutes
const SESSION_CLEANUP_INTERVAL = 5 * 60 * 1000 // 5 minutes

function cleanupSessions(): void {
  const now = Date.now()
  for (const [id, store] of sessions) {
    const lastActivity = store.turns[store.turns.length - 1]?.messages[0]?.timestamp || 0
    if (now - lastActivity > MAX_SESSION_AGE_MS) {
      sessions.delete(id)
    }
  }
}

// Run cleanup periodically
setInterval(cleanupSessions, SESSION_CLEANUP_INTERVAL)

function updateToolOutputIndex(
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
        entry.lastSeenTurnIdx = Math.floor(i / 10)
        entry.callCount++
        if (entry.output !== output) entry.output = output
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

async function syncSession(
  sessionId: string,
  messages: any[],
): Promise<{ messages: any[]; sourceTokens: number; compressedTokens: number; reduction: string }> {
  if (!Array.isArray(messages)) {
    log.error("Expected messages to be array")
    return { messages: [], sourceTokens: 0, compressedTokens: 0, reduction: "0%" }
  }

  let store = sessions.get(sessionId)

  if (!store) {
    store = {
      source: [],
      turns: [],
      toolOutputs: new Map(),
    }
    sessions.set(sessionId, store)
  }

  updateToolOutputIndex(messages, store.toolOutputs)
  store.source = messages
  store.turns = splitIntoTurns(messages)

  const completedTurns = store.turns.filter((t) => !t.isCurrent)
  for (const turn of completedTurns) {
    if (turn.summaryStatus !== "pending") continue

    const db = await getStore()
    const cached = db.getByHash(turn.contentHash)
    if (cached) {
      turn.summary = cached
      turn.summaryStatus = "done"
    } else {
      triggerAsyncSummary(sessionId, turn).catch(() => {})
    }
  }

  const { messages: compressed, sourceTokens, compressedTokens, reduction } =
    buildCompressedMessages(store.turns, store.toolOutputs)

  log.info(
    `session=${sessionId.slice(0, 8)}.. turns=${store.turns.length} ` +
    `tokens=${sourceTokens}→${compressedTokens} (${reduction})`
  )

  return { messages: compressed, sourceTokens, compressedTokens, reduction }
}

async function triggerAsyncSummary(sessionId: string, turn: Turn): Promise<void> {
  const key = `${sessionId}:${turn.contentHash}`
  if (inFlightSummaries.has(key)) return
  inFlightSummaries.add(key)

  turn.summaryStatus = "generating"

  try {
    const summary = await generateSummary(turn.index, turn.messages, sessionId, turn.contentHash)
    if (summary) {
      turn.summary = summary
      turn.summaryStatus = "done"
    } else {
      turn.summaryStatus = "unavailable"
    }

    for (const [, s] of sessions) {
      const t = s.turns.find(
        (x) => x.index === turn.index && !x.isCurrent && x.contentHash === turn.contentHash,
      )
      if (t && t !== turn) {
        t.summary = summary || t.summary
        t.summaryStatus = summary ? "done" : "unavailable"
      }
    }
  } catch {
    turn.summaryStatus = "unavailable"
  } finally {
    inFlightSummaries.delete(key)
  }
}

// ─── History Detection ───────────────────────────────────────────────────────

function detectHistoryQuery(parts: any[]): string | null {
  let text = ""
  for (const p of parts) {
    if (p?.type === "text") text += p.text ?? ""
  }
  text = text.toLowerCase().trim()
  if (!text) return null

  const patterns: RegExp[] = [
    /\b(earlier|before|previously|last time|last session|last I|revisit|follow up)\b/,
    /\b(what did I do|what was I working on|show me my|continue that|repeat)\b/,
    /\b(that|this|it).{0,30}(we|I|you).{0,30}(did|made|created|changed|working)\b/i,
    /(?:^|[^a-zA-Z0-9])(之前|上次|之前的|之前做的|那个项目|继续之前|回顾)(?:$|[^a-zA-Z0-9])/,
    /(?:^|[^a-zA-Z0-9])(我之前|我上次|我们之前|它之前|那个文件|那行代码|继续做)(?:$|[^a-zA-Z0-9])/,
    /(?:^|[^a-zA-Z0-9])(我做了什么|我在做什么|做了什么东西|接着之前)(?:$|[^a-zA-Z0-9])/,
  ]

  for (const p of patterns) {
    if (p.test(text)) return text
  }

  if (
    text.length < 50 &&
    /(?:^|[^a-zA-Z0-9])(this|that|it|这里|那里|这个|那个|它|那)(?:$|[^a-zA-Z0-9])/.test(text) &&
    !/(?:^|[^a-zA-Z0-9])(是什么|怎么|help me|what is)(?:$|[^a-zA-Z0-9])/.test(text)
  ) {
    return text
  }

  return null
}

// ─── Recall Prompt Builder ─────────────────────────────────────────────────────

function buildRecallPrompt(
  query: string,
  summary: TurnSummary,
  messages: Array<{ role: string; content: string; toolCalls?: unknown }>,
): string {
  const conversationText = messages.map((msg, idx) => {
    let header = `[${idx}] ${msg.role.toUpperCase()}`
    if (msg.toolCalls) {
      const calls = msg.toolCalls as Array<{ name: string }>
      header += ` (tools: ${calls.map((t) => t.name).join(", ")})`
    }
    return `${header}\n${msg.content}`
  }).join("\n\n---\n\n")

  return `You are a memory recall assistant. Given a conversation turn and a query, recall the most relevant information that answers the user's question.

QUERY: "${query}"

CONTEXT:
- Intent: ${summary.intent}
- Outcome: ${summary.outcome}
- Overview: ${summary.overview}

CONVERSATION:
${conversationText}

---

Recall (output directly to answer the query):`
}

// ─── Resume Snapshot Builder ───────────────────────────────────────────────────

function buildResumeSnapshot(
  events: any[],
  compactCount: number,
): string {
  const byCategory: Record<string, typeof events> = {}
  for (const ev of events) {
    (byCategory[ev.category || "other"] ??= []).push(ev)
  }

  const sections: string[] = []

  function dedupe(items: string[], max = 15): string[] {
    return [...new Set(items.filter((s) => s.length > 0))].slice(0, max)
  }

  const fileEvents = byCategory["file"] ?? []
  if (fileEvents.length > 0) {
    const lines: string[] = []
    const fileMap = new Map<string, { reads: number; writes: number }>()
    for (const ev of fileEvents) {
      let e = fileMap.get(ev.data)
      if (!e) { e = { reads: 0, writes: 0 }; fileMap.set(ev.data, e) }
      if (ev.type === "file_write") e.writes++
      else e.reads++
    }
    for (const [path, { reads, writes }] of Array.from(fileMap.entries()).slice(-12)) {
      const name = path.split("/").pop() ?? path
      const parts: string[] = []
      if (reads > 0) parts.push(`read×${reads}`)
      if (writes > 0) parts.push(`write×${writes}`)
      lines.push(`  ${name} (${parts.join(", ")})`)
    }
    if (lines.length > 0) sections.push(`Files (${fileMap.size} tracked):\n${lines.join("\n")}`)
  }

  const gitEvents = byCategory["git"] ?? []
  if (gitEvents.length > 0) {
    sections.push(`Git operations (${gitEvents.length}):\n${dedupe(gitEvents.map((e) => `  ${e.data}`), 8).join("\n")}`)
  }

  const errorEvents = byCategory["error"] ?? []
  if (errorEvents.length > 0) {
    sections.push(`Errors encountered:\n${dedupe(errorEvents.map((e) => `  - ${e.data}`), 5).join("\n")}`)
  }

  const mcpEvents = byCategory["mcp"] ?? []
  if (mcpEvents.length > 0) {
    const counts = new Map<string, number>()
    for (const ev of mcpEvents) counts.set(ev.data, (counts.get(ev.data) ?? 0) + 1)
    const lines: string[] = []
    for (const [name, count] of counts) lines.push(`  ${name} (${count}×)`)
    sections.push(`MCP tools used:\n${lines.join("\n")}`)
  }

  if (sections.length === 0) return ""

  return `=== Session Resume (compact #${compactCount}, ${events.length} events) ===\nFor full details on any item, use: ctx_summary_search(query="...", limit=5)\n\n${sections.join("\n\n")}`
}

// ─── Category Inference ─────────────────────────────────────────────────────

function inferCategory(toolName: string): string {
  const t = toolName.toLowerCase()
  if (t === "read" || t === "write" || t === "edit" || t === "glob" || t === "grep") return "file"
  if (t === "git" || t.startsWith("git ")) return "git"
  if (t.includes("search") || t.includes("index")) return "search"
  if (t.includes("exec") || t.includes("shell")) return "exec"
  if (t.includes("mcp") || t.includes("ctx_")) return "mcp"
  if (t.includes("skill")) return "skill"
  return "other"
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

validateLLMConfig()

export const TransformPlugin: any = async ({ client, directory }) => {
  initAppLogger(client)
  log.info(`Session started, data dir: ${DATA_DIR}`)
  return {
  "tool.execute.after": async (input: any, output: any) => {
    try {
      const toolName = input.tool ?? ""
      const toolSessionId = input.sessionID ?? output.sessionID ?? ""
      const args = input.args ?? {}
      if (!toolSessionId || !toolName) return

      const outputStr = output?.output ?? ""
      const bytesReturned = new TextEncoder().encode(outputStr).length

      sTrackToolCall(toolSessionId, toolName, bytesReturned)

      const category = inferCategory(toolName)
      sInsertSessionEvent({
        session_id: toolSessionId,
        type: "tool_call",
        category,
        data: args?.filePath || args?.path || toolName,
        tool: toolName,
        args: JSON.stringify(args ?? {}),
        result: outputStr.slice(0, 500),
        bytes_returned: bytesReturned,
        source_hook: "tool.execute.after",
      })
    } catch (err) {
      log.warn("tool.execute.after hook failed:", String(err))
    }
  },

  tool: {
    ctx_summary_list: tool({
      description: "List all turn summaries for the current session, in chronological order.",
      args: {},
      async execute(_args, context) {
        try {
          const db = getStore()
          const summaries = db.listBySession(context.sessionID)
          return JSON.stringify({ sessionId: context.sessionID, count: summaries.length, results: summaries }, null, 2)
        } catch (err) {
          return `Error: ${String(err)}`
        }
      },
    }),

    ctx_summary_search: tool({
      description: "Full-text search across turn summaries using FTS5. Returns matching summaries ranked by relevance.",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional().default(5),
      },
      async execute(args, context) {
        try {
          const db = getStore()
          const results = db.search(args.query, args.limit ?? 5)
          return JSON.stringify({ query: args.query, count: results.length, results }, null, 2)
        } catch (err) {
          return `Error: ${String(err)}`
        }
      },
    }),

    ctx_summary_get: tool({
      description: "Get a single turn summary by session ID and turn index.",
      args: {
        sessionId: tool.schema.string().optional(),
        turnIndex: tool.schema.number(),
      },
      async execute(args, context) {
        try {
          const sessionId = args.sessionId ?? context.sessionID
          const db = getStore()
          const summary = db.getSummary(sessionId, args.turnIndex)
          if (!summary) return `Summary not found: session=${sessionId} turn=${args.turnIndex}`
          return JSON.stringify({ sessionId, turnIndex: args.turnIndex, summary }, null, 2)
        } catch (err) {
          return `Error: ${String(err)}`
        }
      },
    }),

    ctx_summary_messages: tool({
      description: "Get raw messages for a specific turn (lossless recall). Use to recover full tool call details.",
      args: {
        sessionId: tool.schema.string().optional(),
        turnIndex: tool.schema.number(),
      },
      async execute(args, context) {
        try {
          const sessionId = args.sessionId ?? context.sessionID
          const db = getStore()
          const messages = db.getMessages(sessionId, args.turnIndex)
          return JSON.stringify({ sessionId, turnIndex: args.turnIndex, count: messages.length, messages }, null, 2)
        } catch (err) {
          return `Error: ${String(err)}`
        }
      },
    }),

    ctx_recall: tool({
      description: "Intent-driven recall: search conversation history by natural language, returns LLM-generated context summary.",
      args: {
        query: tool.schema.string(),
        limit: tool.schema.number().optional().default(3),
      },
      async execute(args, context) {
        try {
          const db = getStore()
          const summaries = db.search(args.query, args.limit ?? 3)
          if (summaries.length === 0) {
            return JSON.stringify({ query: args.query, totalFound: 0, recalls: [] }, null, 2)
          }

          const recalls: any[] = []
          for (const summary of summaries as any[]) {
            const messages = db.getMessages(summary.sessionId || context.sessionID, summary.turnIndex)
            const prompt = buildRecallPrompt(args.query, summary, messages)
            let recallText = "(summary only)"
            if (LLM_CONFIG.apiKey && LLM_CONFIG.apiKey !== "placeholder") {
              try {
                const res = await fetch(`${LLM_CONFIG.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LLM_CONFIG.apiKey}` },
                  body: JSON.stringify({ model: LLM_CONFIG.model, messages: [{ role: "user", content: prompt }], max_tokens: 512, temperature: 0.3 }),
                  signal: AbortSignal.timeout(30000),
                })
                if (res.ok) {
                  const data = await res.json() as any
                  recallText = data.choices?.[0]?.message?.content?.trim() || "(no response)"
                }
              } catch {}
            }
            recalls.push({ turnIndex: summary.turnIndex, sessionId: summary.sessionId || context.sessionID, overview: summary.overview, intent: summary.intent, outcome: summary.outcome, confidence: summary.confidence, recall: recallText })
          }
          return JSON.stringify({ query: args.query, totalFound: recalls.length, recalls }, null, 2)
        } catch (err) {
          return `Error: ${String(err)}`
        }
      },
    }),

    ctx_session: tool({
      description: "Session analytics: events tracked, tool call stats, category breakdown, and context savings report.",
      args: {},
      async execute(_args, context) {
        try {
          sEnsureSession(context.sessionID, context.directory)

          const meta = sGetSessionMeta(context.sessionID)
          if (!meta) return `Session ${context.sessionID} not found`

          const events = sGetSessionEvents(context.sessionID, { limit: 1000 }) as Array<Record<string, unknown>>
          const toolStats = sGetToolCallStats(context.sessionID)
          const totalEvents = sGetEventCount(context.sessionID)

          const catMap = new Map<string, { count: number; previews: Set<string> }>()
          for (const ev of events as any[]) {
            const cat = String(ev.category || "other")
            let entry = catMap.get(cat)
            if (!entry) { entry = { count: 0, previews: new Set() }; catMap.set(cat, entry) }
            entry.count++
            if (entry.previews.size < 5) {
              let display = String(ev.data ?? "")
              if (cat === "file") display = display.split("/").pop() ?? display
              if (display.length > 40) display = display.slice(0, 37) + "..."
              entry.previews.add(display)
            }
          }

          const categoryLabels: Record<string, string> = {
            file: "Files tracked", git: "Git operations", task: "Tasks in progress",
            error: "Errors caught", decision: "Key decisions", rule: "Project rules",
            env: "Environment setup", cwd: "Working directory", mcp: "MCP tools used",
            skill: "Skills used", subagent: "Delegated work",
          }

          const byCategory = Array.from(catMap.entries())
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 10)
            .map(([cat, { count, previews }]) => ({
              category: cat,
              count,
              label: categoryLabels[cat] ?? cat,
              preview: Array.from(previews).join(", "),
            }))

          let bytesReturned = 0
          for (const ev of events) bytesReturned += (ev as any).bytes_returned ?? 0

          const startMs = new Date(meta.started_at).getTime()
          const uptimeMin = ((Date.now() - startMs) / 60_000).toFixed(1)

          const analytics = {
            sessionId: meta.session_id,
            projectDir: meta.project_dir,
            startedAt: meta.started_at,
            uptimeMin,
            totalEvents,
            compactCount: meta.compact_count,
            byCategory,
            toolStats,
            bytesReturned,
          }

          sIncrementCompactCount(context.sessionID)
          const snapshot = buildResumeSnapshot(events as Array<Record<string, unknown>>, Number(meta.compact_count) + 1)
          if (snapshot) sUpsertResume(context.sessionID, snapshot, events.length)

          const lines: string[] = []
          lines.push("=== Session Statistics ===")
          lines.push(`Session:  ${analytics.sessionId}`)
          lines.push(`Project:  ${analytics.projectDir}`)
          lines.push(`Uptime:   ${analytics.uptimeMin} min`)
          lines.push(`Events:   ${analytics.totalEvents} tracked`)
          lines.push(`Compacts: ${analytics.compactCount}`)
          lines.push("")
          if (analytics.toolStats.totalCalls > 0) {
            lines.push("--- Tool Calls ---")
            lines.push(`Total: ${analytics.toolStats.totalCalls} calls`)
            for (const [tool, stats] of Object.entries(analytics.toolStats.byTool).sort((a, b) => b[1].calls - a[1].calls).slice(0, 8)) {
              lines.push(`  ${tool}: ${stats.calls} calls`)
            }
            lines.push("")
          }
          if (byCategory.length > 0) {
            lines.push("--- Event Categories ---")
            const maxCount = byCategory[0].count
            for (const cat of byCategory) {
              const bar = maxCount > 0 ? "█".repeat(Math.max(1, Math.round((cat.count / maxCount) * 20))) : ""
              lines.push(`  ${cat.label.padEnd(20)} ${String(cat.count).padStart(4)} ${bar}`)
            }
          }

          return lines.join("\n")
        } catch (err) {
          return `Error: ${String(err)}`
        }
      },
    }),
  },

  "experimental.chat.messages.transform": async (input: any, output: any) => {
    try {
      log.info(`[hook:transform] called, messages=${output?.messages?.length ?? "undefined"}`)

      if (!output?.messages || !Array.isArray(output.messages)) {
        log.warn(`[hook:transform] abort: output.messages is not an array`)
        return
      }

      const rawMessages = output.messages

      const messages = rawMessages.map((m: any) => ({
        info: m.info ?? {},
        parts: m.parts ?? [],
      }))

      if (messages.length === 0) {
        log.warn(`[hook:transform] abort: no messages`)
        return
      }

      log.info(`[hook:transform] session dir=${directory}, roles=${messages.map((m: any) => m.info?.role).join(",")}`)

      const sessionId = output.messages[0]?.info?.metadata?.sessionID
        ?? output.sessionID
        ?? SESSION_ID
      log.info(`[hook:transform] sessionId=${sessionId} dir=${directory}`)
      const beforeIds = messages.map((m: any) => m.info?.id).join(",")
      const beforeText = messages.map((m: any) => {
        const txt = (m.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text?.slice(0, 80)).join("|")
        return `${m.info?.role}:${txt.slice(0, 80)}`
      }).join(" || ")
      log.info(`[hook:transform] BEFORE msgs=${messages.length} ids=${beforeIds} texts=${beforeText}`)

      sEnsureSession(sessionId, directory)

      const { messages: compressed, sourceTokens, compressedTokens, reduction } =
        await syncSession(sessionId, messages)

      const afterIds = compressed.map((m: any) => m.info?.id).join(",")
      const afterText = compressed.map((m: any) => {
        const txt = (m.parts || []).filter((p: any) => p.type === "text").map((p: any) => p.text?.slice(0, 80)).join("|")
        return `${m.info?.role}:${txt.slice(0, 80)}`
      }).join(" || ")
      log.info(`[hook:transform] AFTER  msgs=${compressed.length} ids=${afterIds} texts=${afterText}`)

      const sdkMessages = compressed.map((m: any) => ({
        info: m.info ?? {},
        parts: m.parts ?? [],
      }))

      output.messages.splice(0, output.messages.length, ...sdkMessages)

      const lastMsg = messages[messages.length - 1]
      if (!lastMsg || getRole(lastMsg) !== "user") return

      const query = detectHistoryQuery(lastMsg.parts || [])
      if (!query) return

      const db = getStore()
      const results = db.search(query, 3)
      if (results.length === 0) return

      const injected = results.map((s) => ({
        info: { role: "system", __transformInjected: true },
        parts: [{ type: "text" as const, text: `=== Historical Context ===\n[Turn ${s.turnIndex}] ${s.overview}${s.intent ? ` | Intent: ${s.intent}` : ""}${s.outcome ? ` | ${s.outcome}` : ""}` }],
      }))

      const insertAt = messages.length - 1
      output.messages.splice(insertAt, 0, ...injected)

      log.info(
        `Injected ${injected.length} history blocks, compression=${sourceTokens}→${compressedTokens} (${reduction})`
      )
    } catch (err) {
      log.error("Transform hook failed:", String(err))
    }
  },
}
}

export default TransformPlugin
