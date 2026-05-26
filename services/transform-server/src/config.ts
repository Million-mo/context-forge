import { readFileSync } from "fs"
import { resolve } from "path"
import type { AppConfig } from "./types.js"

function loadConfig(): AppConfig {
  const configPath = resolve(process.cwd(), "config.json")
  const raw = readFileSync(configPath, "utf-8")
  return JSON.parse(raw) as AppConfig
}

export const config = loadConfig()
