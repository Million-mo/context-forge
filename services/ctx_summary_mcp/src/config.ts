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
  
  // Fall back to example if config doesn't exist
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
  
  // Fall back to env vars for secrets
  if (process.env.LLM_API_KEY) {
    config.llm.apiKey = process.env.LLM_API_KEY
  }

  // Local/self-hosted LLM (default) doesn't require API key
  // Only require key for anthropic (which always needs one)
  if (!config.llm.apiKey && config.llm.provider === "anthropic") {
    console.warn("[config] No apiKey set for anthropic — recall generation disabled")
  }

  return config
}

export const config = loadConfig()
