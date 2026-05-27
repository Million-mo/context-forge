// Re-export shared types from the canonical package
export type {
  TurnSummary,
  StoredMessage,
  ToolCall,
  ActionEntry,
  ArtifactChange,
  OutcomeType,
  ArtifactAction,
  RecallOptions,
  RecallResult,
  RecallItem,
  SummaryWithSession,
} from "@context-forge/types"

// ─── Local-only types (not in transform.ts) ──────────────────────────────────

export interface RecallConfig {
  llm: {
    provider: "openai" | "anthropic"
    model: string
    apiKey: string
    baseUrl: string
    maxTokens: number
    temperature: number
  }
}

export interface RecallLLMConfig {
  provider: "openai" | "anthropic"
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  temperature: number
}
