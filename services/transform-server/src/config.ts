import { readFileSync, existsSync, mkdirSync } from "fs"
import { resolve } from "path"
import type { AppConfig } from "./types.js"

function loadConfig(): AppConfig {
  const configPath = resolve(process.cwd(), "config.json")
  const raw = readFileSync(configPath, "utf-8")
  const cfg = JSON.parse(raw) as AppConfig

  // Fall back to env vars for secrets
  if (process.env.LLM_API_KEY) {
    cfg.llm.apiKey = process.env.LLM_API_KEY
  }

  // Apply defaults for decay weights so missing fields don't cause runtime errors
  const dw = cfg.server.decayWeights
  if (dw.distance === undefined) dw.distance = 1.0
  if (dw.time === undefined) dw.time = 0.3
  if (dw.frequency === undefined) dw.frequency = 0.5
  if (cfg.server.tokenBudget === undefined) cfg.server.tokenBudget = 8000
  if (cfg.server.maxHotTurns === undefined) cfg.server.maxHotTurns = 5

  return cfg
}

export const config = loadConfig()

// Ensure the data directory exists for persistent storage
const dataDir = resolve(process.cwd(), "data")
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true })
}
