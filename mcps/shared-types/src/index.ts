// ─── Database ────────────────────────────────────────────────────────────────

export { Database, openDatabase, openReadonlyDatabase } from "./db.js"
export type { PreparedStatement } from "./db.js"

// ─── LLM Client ──────────────────────────────────────────────────────────────

export { OpenAIClient, createLLMClient } from "./llm-client.js"
export type { ChatMessage, ChatResult, ChatError, ChatResponse } from "./llm-client.js"

// ─── Paths ────────────────────────────────────────────────────────────────────

export {
  getGlobalConfigDir,
  getGlobalDataDir,
  getOpenCodePluginsDir,
  getProjectConfigDir,
  getProjectDataDir,
  getGlobalConfigPath,
  getProjectConfigPath,
  getCavemanFlagPath,
  getSummariesDbPath,
  getContentDbPath,
  getSessionsDir,
} from "./paths.js"

// ─── Config ───────────────────────────────────────────────────────────────────

export {
  loadConfig,
  loadLLMConfig,
  loadCavemanConfig,
} from "./config.js"
export type { LLMConfig, CavemanConfig, AppConfig } from "./config.js"

// ─── Core Types ───────────────────────────────────────────────────────────────

export type OutcomeType = "success" | "partial" | "failure" | "unknown"

export type ArtifactAction = "created" | "modified" | "deleted" | "read"

// ─── TurnSummary Types ────────────────────────────────────────────────────────

export interface ActionEntry {
  tool: string
  target: string
  description: string
  result: string
}

export interface ArtifactChange {
  path: string
  action: ArtifactAction
  detail: string
}

export interface ToolCall {
  name: string
  input: string   // JSON-serialized tool input
  output?: string
}

export interface TurnSummary {
  turnIndex: number
  overview: string
  intent: string
  actions: ActionEntry[]
  artifacts: ArtifactChange[]
  outcome: OutcomeType
  errors: string[]
  todos: string[]
  confidence: number
  reason?: string
  tokensUsed?: number
  generatedAt: number
  startMsgId: string
  endMsgId: string
}

// ─── StoredMessage ────────────────────────────────────────────────────────────

export interface StoredMessage {
  msgId: string
  sessionId: string
  turnIndex: number
  role: "user" | "assistant" | "tool"
  content: string
  toolCalls?: ToolCall[]
  createdAt: number
  seqInTurn: number
}

// ─── Recall Types ─────────────────────────────────────────────────────────────

export interface RecallOptions {
  query: string
  sessionId?: string
  limit?: number
}

export interface RecallResult {
  query: string
  totalFound: number
  recalls: RecallItem[]
}

export interface RecallItem {
  turnIndex: number
  sessionId: string
  overview: string
  intent: string
  outcome: OutcomeType
  confidence: number
  recall: string
}

export interface SummaryWithSession extends TurnSummary {
  sessionId: string
}
