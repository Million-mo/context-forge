/**
 * Interactive configuration setup for Context Forge.
 *
 * Usage:
 *   npx tsx scripts/setup-config.ts              (interactive)
 *   npx tsx scripts/setup-config.ts --noninteractive  (use env vars or defaults)
 *
 * Guides the user through LLM configuration and creates
 * <project>/.ctx_plugin/config.json.
 *
 * Priority: env var > existing config > prompts
 */

import * as readline from "node:readline"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "url"

const __dirname = fileURLToPath(import.meta.url)
const ROOT = resolve(__dirname, "..")
const PROJECT_CONFIG_DIR = resolve(ROOT, ".ctx_plugin")
const PROJECT_CONFIG_PATH = resolve(PROJECT_CONFIG_DIR, "config.json")

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

interface LLMConfig {
  provider: "openai" | "anthropic"
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  temperature: number
}

interface CavemanConfig {
  defaultMode: string
}

interface AppConfig {
  llm: LLMConfig
  caveman: CavemanConfig
}

interface LlmPreset {
  name: string
  baseUrl: string
  model: string
  hint: string
}

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const PRESETS: LlmPreset[] = [
  {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    hint: "api.openai.com",
  },
  {
    name: "OpenAI Compatible (Groq / Perplexity / 等)",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    hint: "api.groq.com",
  },
  {
    name: "GLM (智谱) — 国内推荐",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    hint: "open.bigmodel.cn",
  },
  {
    name: "SiliconFlow (硅基流动)",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-72B-Instruct",
    hint: "api.siliconflow.cn",
  },
  {
    name: "Custom / Other (自定义)",
    baseUrl: "",
    model: "",
    hint: "自定义端点",
  },
]

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function readJsonFile<T = unknown>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return null
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(question + " ", (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function waitFor(question: string, fallback: string): Promise<string> {
  const answer = await prompt(question + ` (直接回车 = ${fallback})`)
  return answer || fallback
}

async function confirm(question: string, defaultVal: boolean): Promise<boolean> {
  const suffix = defaultVal ? " [Y/n]" : " [y/N]"
  const answer = await prompt(question + suffix + "：")
  if (!answer) return defaultVal
  return answer.toLowerCase() === "y"
}

// ─────────────────────────────────────────────────────────
// Config loading
// ─────────────────────────────────────────────────────────

function loadExistingConfig(): AppConfig | null {
  return (
    readJsonFile<AppConfig>(PROJECT_CONFIG_PATH) ||
    readJsonFile<AppConfig>(resolve(ROOT, "config.json")) ||
    readJsonFile<AppConfig>(resolve(process.env.HOME ?? ".", ".config", "ctx_plugin", "config.json")) ||
    null
  )
}

// ─────────────────────────────────────────────────────────
// Interactive setup
// ─────────────────────────────────────────────────────────

async function setupConfig(): Promise<void> {
  console.log("\n" + "=".repeat(58))
  console.log("  Context Forge — 配置向导")
  console.log("  配置 LLM 以启用摘要生成（turn summary）")
  console.log("=".repeat(58) + "\n")

  const existing = loadExistingConfig()
  if (existing?.llm?.apiKey) {
    console.log(`✓ 检测到已有配置：${PROJECT_CONFIG_PATH}`)
    console.log(`  API Key: ${existing.llm.apiKey.slice(0, 8)}...`)
    console.log(`  BaseURL: ${existing.llm.baseUrl}`)
    console.log(`  Model:   ${existing.llm.model}`)
    const overwrite = await confirm("是否重新配置", false)
    if (!overwrite) {
      console.log("\n保持现有配置不变。\n")
      return
    }
  }

  console.log("要生成会话摘要，需要配置 LLM API。\n")
  console.log("请选择 LLM 提供商：\n")
  PRESETS.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.name}  (${p.hint})`)
  })
  console.log()

  let presetIdx = 0
  while (true) {
    const input = await prompt("选择编号 (1-5，直接回车默认 OpenAI)：")
    if (!input) { presetIdx = 0; break }
    const n = parseInt(input, 10)
    if (n >= 1 && n <= PRESETS.length) { presetIdx = n - 1; break }
    console.log("无效选择，请输入 1-5 之间的数字。")
  }

  const preset = PRESETS[presetIdx]
  console.log(`已选择: ${preset.name}\n`)

  const baseUrl = await waitFor("Base URL", preset.baseUrl)
  const model = await waitFor("Model", preset.model)
  const apiKey = await prompt("API Key（必填）：")

  if (!apiKey) {
    console.log("\n未提供 API Key，摘要功能将被禁用。")
    console.log("后续可通过环境变量或编辑 .ctx_plugin/config.json 配置。\n")
    ensureDir(PROJECT_CONFIG_DIR)
    writeFileSync(PROJECT_CONFIG_PATH, JSON.stringify({
      llm: {
        provider: "openai",
        model: model || "gpt-4o",
        apiKey: "",
        baseUrl: baseUrl || "https://api.openai.com/v1",
        maxTokens: 2048,
        temperature: 0.3,
      },
      caveman: { defaultMode: "full" },
    }, null, 2))
    return
  }

  const maxTokens = parseInt(await waitFor("Max Tokens", "2048"), 10)
  const temperature = parseFloat(await waitFor("Temperature", "0.3"))

  const config: AppConfig = {
    llm: {
      provider: "openai",
      model,
      apiKey,
      baseUrl,
      maxTokens,
      temperature,
    },
    caveman: { defaultMode: "full" },
  }

  ensureDir(PROJECT_CONFIG_DIR)
  writeFileSync(PROJECT_CONFIG_PATH, JSON.stringify(config, null, 2))

  console.log("\n" + "=".repeat(58))
  console.log("✓ 配置已保存到：")
  console.log(`  ${PROJECT_CONFIG_PATH}`)
  console.log("=" .repeat(58))
  console.log("\n摘要生成已启用。下次启动 opencode 时将自动生成会话摘要。")
  console.log("\n后续修改方式：")
  console.log("  1. 直接编辑 ${PROJECT_CONFIG_PATH}")
  console.log("  2. 设置环境变量:")
  console.log("     export CONTEXT_FORGE_LLM_API_KEY=your-key")
  console.log("     export CONTEXT_FORGE_LLM_BASE_URL=https://...")
  console.log("     export CONTEXT_FORGE_LLM_MODEL=gpt-4o")
  console.log()
}

// ─────────────────────────────────────────────────────────
// Non-interactive: update from env vars
// ─────────────────────────────────────────────────────────

function updateFromEnv(): void {
  const existing = loadExistingConfig() || {
    llm: {
      provider: "openai" as const,
      model: "gpt-4o",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      maxTokens: 2048,
      temperature: 0.3,
    },
    caveman: { defaultMode: "full" as const },
  }

  const apiKey =
    process.env.CONTEXT_FORGE_LLM_API_KEY ||
    process.env.TRANSFORM_LLM_API_KEY ||
    process.env.LLM_API_KEY ||
    existing.llm.apiKey

  if (!apiKey) return

  const baseUrl =
    process.env.CONTEXT_FORGE_LLM_BASE_URL ||
    process.env.TRANSFORM_LLM_BASE_URL ||
    process.env.LLM_BASE_URL ||
    existing.llm.baseUrl

  const model =
    process.env.CONTEXT_FORGE_LLM_MODEL ||
    process.env.TRANSFORM_LLM_MODEL ||
    process.env.LLM_MODEL ||
    existing.llm.model

  const config: AppConfig = {
    llm: { ...existing.llm, apiKey, baseUrl, model },
    caveman: existing.caveman,
  }

  ensureDir(PROJECT_CONFIG_DIR)
  writeFileSync(PROJECT_CONFIG_PATH, JSON.stringify(config, null, 2))
  console.log(`[setup-config] 已从环境变量更新配置 -> ${PROJECT_CONFIG_PATH}`)
}

// ─────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────

async function main() {
  const SKIP = process.argv.includes("--skip")

  if (!SKIP) {
    if (!process.stdin.isTTY || process.argv.includes("--noninteractive")) {
      updateFromEnv()
    } else {
      await setupConfig()
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
