/**
 * Unified config loader for Context Forge.
 *
 * Priority: env var > project config.json > global config.json > defaults
 *
 * Config file format (both global and project-level):
 * {
 *   "llm": {
 *     "provider": "openai",
 *     "model": "GLM-4.7",
 *     "apiKey": "",
 *     "baseUrl": "http://116.204.104.177:8123",
 *     "maxTokens": 2048,
 *     "temperature": 0.3
 *   },
 *   "caveman": {
 *     "defaultMode": "full"
 *   },
 *   "dataDir": "./data"
 * }
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getGlobalConfigPath, getProjectConfigPath } from "./paths.js"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface LLMConfig {
  provider: "openai" | "anthropic"
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  temperature: number
}

export interface CavemanConfig {
  defaultMode: string
}

export interface AppConfig {
  llm: LLMConfig
  caveman: CavemanConfig
}

// ─────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────

const DEFAULTS: AppConfig = {
  llm: {
    provider: "openai",
    model: "GLM-4.7",
    apiKey: "",
    baseUrl: "http://116.204.104.177:8123",
    maxTokens: 2048,
    temperature: 0.3,
  },
  caveman: {
    defaultMode: "full",
  },
}

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const result = { ...base } as Record<string, any>
  for (const key of Object.keys(override)) {
    if (override[key] !== undefined && override[key] !== null) {
      if (typeof override[key] === "object" && !Array.isArray(override[key])) {
        result[key] = deepMerge(result[key] || {}, override[key])
      } else {
        result[key] = override[key]
      }
    }
  }
  return result as T
}

function readJsonFile(path: string): Partial<AppConfig> | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf-8")
    return JSON.parse(raw) as Partial<AppConfig>
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────
// Main loader
// ─────────────────────────────────────────────────────────

export function loadConfig(projectDir?: string): AppConfig {
  // 1. Start with defaults
  let config = { ...DEFAULTS }

  // 2. Merge global config (~/.ctx_plugin/config.json)
  const globalPath = getGlobalConfigPath()
  const globalCfg = readJsonFile(globalPath)
  if (globalCfg) {
    config = deepMerge(config, globalCfg)
  }

  // 3. Merge project config (<project>/.ctx_plugin/config.json)
  const projectPath = getProjectConfigPath(projectDir)
  const projectCfg = readJsonFile(projectPath)
  if (projectCfg) {
    config = deepMerge(config, projectCfg)
  }

  // Also try legacy config.json at project root for migration
  const legacyPath = resolve(projectDir || process.cwd(), "config.json")
  const legacyCfg = readJsonFile(legacyPath)
  if (legacyCfg) {
    config = deepMerge(config, legacyCfg)
  }

  // 4. Env var overrides (highest priority)
  // LLM
  if (process.env.CONTEXT_FORGE_LLM_API_KEY) {
    config.llm.apiKey = process.env.CONTEXT_FORGE_LLM_API_KEY
  } else if (process.env.TRANSFORM_LLM_API_KEY) {
    config.llm.apiKey = process.env.TRANSFORM_LLM_API_KEY
  } else if (process.env.LLM_API_KEY) {
    config.llm.apiKey = process.env.LLM_API_KEY
  }

  if (process.env.CONTEXT_FORGE_LLM_BASE_URL) {
    config.llm.baseUrl = process.env.CONTEXT_FORGE_LLM_BASE_URL
  } else if (process.env.TRANSFORM_LLM_BASE_URL) {
    config.llm.baseUrl = process.env.TRANSFORM_LLM_BASE_URL
  } else if (process.env.LLM_BASE_URL) {
    config.llm.baseUrl = process.env.LLM_BASE_URL
  }

  if (process.env.CONTEXT_FORGE_LLM_MODEL) {
    config.llm.model = process.env.CONTEXT_FORGE_LLM_MODEL
  } else if (process.env.TRANSFORM_LLM_MODEL) {
    config.llm.model = process.env.TRANSFORM_LLM_MODEL
  } else if (process.env.LLM_MODEL) {
    config.llm.model = process.env.LLM_MODEL
  }

  // Caveman
  if (process.env.CAVEMAN_DEFAULT_MODE) {
    config.caveman.defaultMode = process.env.CAVEMAN_DEFAULT_MODE.toLowerCase()
  }

  return config
}

/**
 * Quick accessor: loads config and returns LLM portion.
 */
export function loadLLMConfig(projectDir?: string): LLMConfig {
  return loadConfig(projectDir).llm
}

/**
 * Quick accessor: loads config and returns caveman portion.
 */
export function loadCavemanConfig(projectDir?: string): CavemanConfig {
  return loadConfig(projectDir).caveman
}
