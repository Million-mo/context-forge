import { readFileSync, existsSync } from "fs"
import { resolve } from "path"

// Data directory for summaries DB
const DEFAULT_DATA_DIR = resolve(process.cwd(), "data")
export const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR

export interface RecallConfig {
  llm: {
    provider: "openai" | "anthropic"
    model: string
    apiKey: string
    baseUrl: string
    maxTokens: number
    temperature: number
  }
  dataDir: string
}

function loadConfig(): RecallConfig {
  const configPath = resolve(process.cwd(), "config.json")
  const fallbackPath = resolve(process.cwd(), "config.json.example")
  const finalPath = existsSync(configPath) ? configPath : fallbackPath

  let config: RecallConfig

  if (!existsSync(finalPath)) {
    console.warn("[config] No config file found, using defaults")
    config = {
      llm: {
        provider: "openai",
        model: "glm-4-flash",
        apiKey: "",
        baseUrl: "http://localhost:8080",
        maxTokens: 2048,
        temperature: 0.3,
      },
      dataDir: DATA_DIR,
    }
  } else {
    const raw = readFileSync(finalPath, "utf-8")
    config = JSON.parse(raw) as RecallConfig
    config.dataDir = DATA_DIR
  }

  // Unified env var (CONTEXT_FORGE_LLM_*) takes precedence, then legacy vars, then config.json
  if (process.env.CONTEXT_FORGE_LLM_API_KEY) {
    config.llm.apiKey = process.env.CONTEXT_FORGE_LLM_API_KEY
  } else if (process.env.LLM_API_KEY) {
    config.llm.apiKey = process.env.LLM_API_KEY
  }

  if (process.env.CONTEXT_FORGE_LLM_BASE_URL) {
    config.llm.baseUrl = process.env.CONTEXT_FORGE_LLM_BASE_URL
  } else if (process.env.LLM_BASE_URL) {
    config.llm.baseUrl = process.env.LLM_BASE_URL
  }

  if (process.env.CONTEXT_FORGE_LLM_MODEL) {
    config.llm.model = process.env.CONTEXT_FORGE_LLM_MODEL
  } else if (process.env.LLM_MODEL) {
    config.llm.model = process.env.LLM_MODEL
  }

  if (!config.llm.apiKey && config.llm.provider === "anthropic") {
    console.warn("[config] No apiKey set for anthropic — recall generation disabled")
  }

  return config
}

export const config = loadConfig()
