/**
 * One-shot installer for Context Forge.
 *
 * Usage:
 *   npx tsx scripts/install-all.ts           (install + guided config)
 *   npx tsx scripts/install-all.ts --skip-config  (MCP only, skip config)
 *   npx tsx scripts/install-all.ts --uninstall    (remove)
 *
 * Registers mcp_context_forge (unified execution + indexing + memory) into opencode.json.
 * Also unregisters the legacy mcp_ctx_tool and mcp_ctx_summary if present.
 *
 * After MCP registration, runs setup-config to guide LLM configuration (required for summaries).
 */

import { existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "url"
import { spawn } from "node:child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")
const SCRIPTS_DIR = __dirname

const UNINSTALL = process.argv.includes("--uninstall")
const SKIP_CONFIG = process.argv.includes("--skip-config")

// ─────────────────────────────────────────────────────────
// Run a sub-script
// ─────────────────────────────────────────────────────────

function runScript(
  relPath: string,
  extraArgs: string[] = [],
  label?: string
): boolean {
  const scriptPath = resolve(SCRIPTS_DIR, relPath)
  if (!existsSync(scriptPath)) {
    if (label) console.warn(`  ! ${label} not found: ${scriptPath}, skipping`)
    return false
  }
  const labelText = label ?? relPath
  console.log(`\n[install-all] ${labelText}`)
  console.log(`  $ tsx ${relPath} ${extraArgs.join(" ")}`)
  try {
    execSync(`npx tsx "${scriptPath}" ${extraArgs.join(" ")}`, {
      cwd: ROOT,
      stdio: "inherit",
    })
    console.log(`  ✓ ${labelText} done`)
    return true
  } catch (err) {
    console.error(`  ✗ ${labelText} failed`)
    return false
  }
}

// ─────────────────────────────────────────────────────────
// MCP registration
// ─────────────────────────────────────────────────────────

function installMcp(): void {
  console.log("=== Installing Context Forge MCP Server ===\n")

  // Unregister legacy MCPs if they exist
  const legacyTool = resolve(ROOT, "mcps", "mcp_ctx_tool", "dist", "install.js")
  if (existsSync(legacyTool)) {
    try {
      execSync(`node "${legacyTool}" --uninstall`, {
        cwd: resolve(ROOT, "mcps", "mcp_ctx_tool"),
        stdio: "inherit",
      })
      console.log("  ✓ unregister legacy mcp_ctx_tool")
    } catch { /* already gone */ }
  }

  const legacySummary = resolve(ROOT, "mcps", "mcp_ctx_summary", "dist", "install.js")
  if (existsSync(legacySummary)) {
    try {
      execSync(`node "${legacySummary}" --uninstall`, {
        cwd: resolve(ROOT, "mcps", "mcp_ctx_summary"),
        stdio: "inherit",
      })
      console.log("  ✓ unregister legacy mcp_ctx_summary")
    } catch { /* already gone */ }
  }

  // Register unified MCP
  const forgeInstall = resolve(ROOT, "mcps", "mcp_context_forge", "dist", "install.js")
  if (existsSync(forgeInstall)) {
    try {
      execSync(`node "${forgeInstall}"`, {
        cwd: resolve(ROOT, "mcps", "mcp_context_forge"),
        stdio: "inherit",
      })
      console.log("  ✓ mcp_context_forge registered")
    } catch (err) {
      console.error("  ✗ mcp_context_forge registration failed")
      process.exit(1)
    }
  } else {
    console.warn("  ! mcp_context_forge install script not found")
    console.warn("    Build it first: cd mcps/mcp_context_forge && npm install && npm run build")
  }
}

function uninstallMcp(): void {
  console.log("=== Uninstalling Context Forge MCP ===\n")
  const forgeInstall = resolve(ROOT, "mcps", "mcp_context_forge", "dist", "install.js")
  if (existsSync(forgeInstall)) {
    try {
      execSync(`node "${forgeInstall}" --uninstall`, {
        cwd: resolve(ROOT, "mcps", "mcp_context_forge"),
        stdio: "inherit",
      })
      console.log("  ✓ mcp_context_forge unregistered")
    } catch { /* already gone */ }
  }
}

// ─────────────────────────────────────────────────────────
// LLM config setup
// ─────────────────────────────────────────────────────────

async function setupLlmConfig(): Promise<void> {
  const configPath = resolve(ROOT, ".ctx_plugin", "config.json")
  const existing = (() => {
    try {
      if (existsSync(configPath)) {
        const raw = require("node:fs").readFileSync(configPath, "utf-8")
        return JSON.parse(raw)
      }
    } catch { /* ignore */ }
    return null
  })()

  // Check if apiKey is already configured
  if (existing?.llm?.apiKey) {
    console.log("\n[setup-config] 检测到已有 LLM 配置，跳过交互式配置。")
    console.log(`  ${configPath}`)
    console.log(`  API: ${existing.llm.apiKey.slice(0, 8)}... @ ${existing.llm.baseUrl}/${existing.llm.model}`)
    console.log("  如需重新配置，运行: npx tsx scripts/setup-config.ts\n")
    return
  }

  // Check env vars
  const hasEnvKey =
    process.env.CONTEXT_FORGE_LLM_API_KEY ||
    process.env.TRANSFORM_LLM_API_KEY ||
    process.env.LLM_API_KEY

  if (hasEnvKey) {
    console.log("\n[setup-config] 检测到环境变量中的 LLM API Key，正在写入配置...")
    runScript("setup-config.ts", ["--noninteractive"], "setup-config (from env)")
    return
  }

  // No config — prompt user to run setup
  console.log("\n" + "=".repeat(58))
  console.log("  摘要生成需要配置 LLM API")
  console.log("=".repeat(58))
  console.log("\n已跳过交互式配置。可通过以下方式配置：")
  console.log("  方式 1（推荐）：运行配置向导")
  console.log("    npx tsx scripts/setup-config.ts")
  console.log()
  console.log("  方式 2：直接编辑配置文件")
  console.log(`    cp config.json.example .ctx_plugin/config.json`)
  console.log(`    # 然后编辑 .ctx_plugin/config.json 填入 API Key`)
  console.log()
  console.log("  方式 3：设置环境变量")
  console.log("    export CONTEXT_FORGE_LLM_API_KEY=your-key")
  console.log("    export CONTEXT_FORGE_LLM_BASE_URL=https://...")
  console.log("    export CONTEXT_FORGE_LLM_MODEL=gpt-4o")
  console.log()
}

// ─────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (UNINSTALL) {
    uninstallMcp()
    console.log("\n=== All removed ===\n")
  } else {
    installMcp()

    if (!SKIP_CONFIG) {
      await setupLlmConfig()
    }

    console.log("\n=== All done ===")
    console.log("重启 opencode 以加载新的 MCP 服务器。\n")
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
