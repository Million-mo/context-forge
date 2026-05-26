// ─── Summary Types ───────────────────────────────────────────────────────────

export interface ArtifactChange {
  path: string
  action: "created" | "modified" | "deleted" | "read"
  detail: string
}

export interface ActionEntry {
  tool: string
  target: string
  description: string
  result: string
}

export interface TurnSummary {
  turnIndex: number
  overview: string          // ≤20 chars
  intent: string            // user's core ask
  actions: ActionEntry[]
  artifacts: ArtifactChange[]
  outcome: "success" | "partial" | "failure" | "unknown"
  errors: string[]
  todos: string[]
  confidence: number         // 0.0-1.0
  reason?: string           // when outcome!=success or confidence<0.7
  generatedAt: number       // unix ms
  tokensUsed?: number
}

// ─── Server Configuration ─────────────────────────────────────────────────────

export interface DecayWeightsConfig {
  distance: number
  time: number
  frequency: number
}

export interface ServerConfig {
  port: number
  sessionTtlMs: number
  bucketSize: number
  maxHotTurns: number
  decayWeights: DecayWeightsConfig
}

export interface LLMConfig {
  provider: LLMProvider
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  temperature: number
}

export interface AppConfig {
  server: ServerConfig
  llm: LLMConfig
}

// ─── LLM Configuration ────────────────────────────────────────────────────────

export type LLMProvider = "openai" | "anthropic"

// ─── Summary Task Queue ──────────────────────────────────────────────────────

export interface SummaryTask {
  sessionId: string
  turnIndex: number
  messages: any[]
  createdAt: number
  retries: number
}

// ─── Parsed LLM Response ─────────────────────────────────────────────────────

export interface ParsedSummary {
  overview: string
  intent: string
  actions: ActionEntry[]
  artifacts: ArtifactChange[]
  outcome: "success" | "partial" | "failure" | "unknown"
  errors: string[]
  todos: string[]
  confidence: number
  reason?: string
}
