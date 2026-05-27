/**
 * OpenCode Plugin: Transform messages via local compression
 *
 * Embeds all compression logic directly in the plugin — no external server needed.
 *
 * Architecture:
 * - Compression: pure functions (splitIntoTurns, decay scoring, message replacement)
 * - Persistence: SQLite via node:sqlite
 * - LLM summarization: async, non-blocking
 * - Hook: chat.message (fires on every user message)
 *
 * Environment variables:
 *   TRANSFORM_DATA_DIR  - defaults to <workspace>/ctx_plugin/transform-data
 *   TRANSFORM_LLM_API_KEY
 *   TRANSFORM_LLM_BASE_URL  - defaults to http://116.204.104.177:8123
 *   TRANSFORM_LLM_MODEL     - defaults to GLM-4.7
 */

// ─── Imports ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync, appendFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

// ─── Types ─────────────────────────────────────────────────────────────────

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

interface TurnSummary {
  turnIndex: number
  overview: string
  intent: string
  actions: ActionEntry[]
  artifacts: ArtifactChange[]
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

interface ActionEntry {
  tool: string
  target: string
  description: string
  result: string
}

interface ArtifactChange {
  path: string
  action: "created" | "modified" | "deleted" | "read"
  detail: string
}

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

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKSPACE_ROOT = resolve(__dirname, "..", "..")

const DATA_DIR = process.env.TRANSFORM_DATA_DIR
  || resolve(WORKSPACE_ROOT, "ctx_plugin")

const LOG_DIR = resolve(DATA_DIR, "..", "..", ".local", "share", "opencode", "log")
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
  info: (...a: string[]) => { console.log("[Transform]", ...a); writeLog("INFO", ...a) },
  warn: (...a: string[]) => { console.warn("[Transform]", ...a); writeLog("WARN", ...a) },
  error: (...a: string[]) => { console.error("[Transform]", ...a); writeLog("ERROR", ...a) },
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

const LLM_CONFIG = {
  apiKey: process.env.TRANSFORM_LLM_API_KEY || "placeholder",
  baseUrl: process.env.TRANSFORM_LLM_BASE_URL || "http://116.204.104.177:8123",
  model: process.env.TRANSFORM_LLM_MODEL || "GLM-4.7",
  maxTokens: 2048,
  temperature: 0.3,
}

function validateLLMConfig(): void {
  if (LLM_CONFIG.apiKey === "placeholder") {
    log.warn("LLM summarization DISABLED (no API key configured)")
    log.warn("Set TRANSFORM_LLM_API_KEY + TRANSFORM_LLM_BASE_URL to enable turn summaries")
  }
}

// ─── SQLite Store ────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS global_summary_cache (
  content_hash TEXT NOT NULL PRIMARY KEY,
  overview TEXT NOT NULL,
  intent TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT 'unknown',
  errors_json TEXT NOT NULL DEFAULT '[]',
  todos_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  reason TEXT,
  generated_at INTEGER NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 1,
  last_hit_at INTEGER NOT NULL,
  start_msg_id TEXT NOT NULL,
  end_msg_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_turn_summaries (
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_hash ON session_turn_summaries(content_hash);
CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_turn_summaries(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content_hash UNINDEXED,
  overview,
  intent,
  outcome,
  content='global_summary_cache',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON global_summary_cache BEGIN
  INSERT INTO summaries_fts(rowid, content_hash, overview, intent, outcome)
  VALUES (new.rowid, new.content_hash, new.overview, new.intent, new.outcome);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON global_summary_cache BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content_hash, overview, intent, outcome)
  VALUES ('delete', old.rowid, old.content_hash, old.overview, old.intent, old.outcome);
END;

CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON global_summary_cache BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content_hash, overview, intent, outcome)
  VALUES ('delete', old.rowid, old.content_hash, old.overview, old.intent, old.outcome);
  INSERT INTO summaries_fts(rowid, content_hash, overview, intent, outcome)
  VALUES (new.rowid, new.content_hash, new.overview, new.intent, new.outcome);
END;

CREATE TABLE IF NOT EXISTS turn_messages (
  msg_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at INTEGER NOT NULL,
  seq_in_turn INTEGER NOT NULL,
  PRIMARY KEY (msg_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_messages_lookup ON turn_messages(session_id, turn_index, seq_in_turn);
`

class SummaryStore {
  private db: any

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true })
    const dbPath = resolve(DATA_DIR, "summaries.db")
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode=WAL;")
    this.db.exec(SCHEMA)
  }

  getByHash(contentHash: string): TurnSummary | null {
    const stmt = this.db.prepare(
      "SELECT * FROM global_summary_cache WHERE content_hash = ?"
    )
    const row = stmt.get(contentHash) as any
    if (!row) return null

    const updStmt = this.db.prepare(
      "UPDATE global_summary_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE content_hash = ?"
    )
    updStmt.run(Date.now(), contentHash)

    return this.rowToSummary(row)
  }

  insert(summary: TurnSummary, sessionId: string, contentHash: string): void {
    const cacheStmt = this.db.prepare(`
      INSERT OR REPLACE INTO global_summary_cache
        (content_hash, overview, intent, actions_json, artifacts_json,
         outcome, errors_json, todos_json, confidence, reason, generated_at,
         tokens_used, last_hit_at, start_msg_id, end_msg_id)
      VALUES
        (@content_hash, @overview, @intent, @actions_json, @artifacts_json,
         @outcome, @errors_json, @todos_json, @confidence, @reason, @generated_at,
         @tokens_used, @last_hit_at, @start_msg_id, @end_msg_id)
    `)

    const idxStmt = this.db.prepare(`
      INSERT OR REPLACE INTO session_turn_summaries
        (session_id, turn_index, content_hash)
      VALUES (@session_id, @turn_index, @content_hash)
    `)

    cacheStmt.run({
      content_hash: contentHash,
      overview: summary.overview,
      intent: summary.intent,
      actions_json: JSON.stringify(summary.actions),
      artifacts_json: JSON.stringify(summary.artifacts),
      outcome: summary.outcome,
      errors_json: JSON.stringify(summary.errors),
      todos_json: JSON.stringify(summary.todos),
      confidence: summary.confidence,
      reason: summary.reason || null,
      generated_at: summary.generatedAt,
      tokens_used: summary.tokensUsed || 0,
      last_hit_at: Date.now(),
      start_msg_id: summary.startMsgId,
      end_msg_id: summary.endMsgId,
    })

    idxStmt.run({
      session_id: sessionId,
      turn_index: summary.turnIndex,
      content_hash: contentHash,
    })
  }

  insertMessages(sessionId: string, turnIndex: number, messages: any[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO turn_messages
        (msg_id, session_id, turn_index, role, content, tool_calls, created_at, seq_in_turn)
      VALUES (@msg_id, @session_id, @turn_index, @role, @content, @tool_calls, @created_at, @seq_in_turn)
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

      stmt.run({
        msg_id: `${sessionId}-turn${turnIndex}-seq${seq}`,
        session_id: sessionId,
        turn_index: turnIndex,
        role,
        content: textContent,
        tool_calls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        created_at: msg?.timestamp || Date.now(),
        seq_in_turn: seq,
      })
    }
  }

  search(query: string, limit = 5): TurnSummary[] {
    if (!query.trim()) return []

    // Strict validation: only allow safe alphanumeric + common word chars + Chinese
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
      const rows = stmt.all(ftsQuery, limit) as any[]
      return rows.map((row) => this.rowToSummary(row))
    } catch {
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

// Global store instance (initialized lazily)
let store: SummaryStore | null = null
function getStore(): SummaryStore {
  if (!store) store = new SummaryStore()
  return store
}

// ─── LLM Client ──────────────────────────────────────────────────────────────

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
    const url = `${LLM_CONFIG.baseUrl}/v1/chat/completions`
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

    const data = await res.json() as any
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

    getStore().insert(summary, sessionId, contentHash)
    getStore().insertMessages(sessionId, turnIndex, messages)
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
  if (typeof structuredClone === "function") {
    return structuredClone(obj) as T
  }
  return JSON.parse(JSON.stringify(obj)) as T
}

function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

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
        case "summary": return `[COMPRESSED: read "${filePath}"]\n${[
          ...lines.slice(0, 3),
          `  ... ${Math.max(0, lineCount - 6)} more lines ...`,
          ...lines.slice(-3),
        ].join("\n")}`
        case "full": return output
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
        case "summary": return `[COMPRESSED: glob "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(", ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "full": return output
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
        case "summary": return `[COMPRESSED: grep "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(" | ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "full": return output
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
        case "summary": return `[COMPRESSED: webfetch "${url}"]\n${output.slice(0, 200)}...`
        case "full": return output
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
      role: "user",
      info: { role: "user", __compressed: "summary", turnIndex: turn.index },
      parts: [{
        type: "text",
        text: `=== Turn ${turn.index} Summary (${timestamp}) ===\nCompressed: ${turn.messageCount} msgs, ~${turn.tokenEstimate} tokens.`,
      }],
    },
    {
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
          : `(Summary not yet generated)`,
      }],
    },
  ]
}

function buildPlaceholderReplacement(turn: Turn): any[] {
  return [{
    role: "user",
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

function syncSession(
  sessionId: string,
  messages: any[],
): { messages: any[]; sourceTokens: number; compressedTokens: number; reduction: string } {
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

    const cached = getStore().getByHash(turn.contentHash)
    if (cached) {
      turn.summary = cached
      turn.summaryStatus = "done"
    } else {
      triggerAsyncSummary(sessionId, turn)
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

// ─── Plugin ─────────────────────────────────────────────────────────────────

validateLLMConfig()

export const TransformPlugin = () => ({
  "chat.message": async (_input: any, output: any) => {
    if (!output?.messages || !Array.isArray(output.messages)) return

    const messages = output.messages
    if (messages.length === 0) return

    const sessionId = SESSION_ID

    // Step 1: Compress message history
    const { messages: compressed, sourceTokens, compressedTokens, reduction } =
      syncSession(sessionId, messages)

    output.messages.splice(0, output.messages.length, ...compressed)

    // Step 2: Inject history context if needed
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || getRole(lastMsg) !== "user") return

    const query = detectHistoryQuery(lastMsg.parts || [])
    if (!query) return

    const results = getStore().search(query, 3)
    if (results.length === 0) return

    const injected = results.map((s) => ({
      role: "system" as const,
      info: { role: "system", __transformInjected: true },
      parts: [{
        type: "text" as const,
        text: `=== Historical Context ===\n` +
          `[Turn ${s.turnIndex}] ${s.overview}${s.intent ? ` | Intent: ${s.intent}` : ""}${s.outcome ? ` | ${s.outcome}` : ""}`,
      }],
    }))

    const insertAt = messages.length - 1
    output.messages.splice(insertAt, 0, ...injected)

    log.info(
      `Injected ${injected.length} history blocks, ` +
      `compression=${sourceTokens}→${compressedTokens} (${reduction})`
    )
  },

  "session.created": async () => {
    log.info(`Session started, data dir: ${DATA_DIR}`)
  },
})

export default TransformPlugin
