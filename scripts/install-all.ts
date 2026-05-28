/**
 * One-shot installer for all MCP servers.
 *
 * Usage:
 *   npx tsx scripts/install-all.ts        (install all)
 *   npx tsx scripts/install-all.ts --uninstall  (remove all)
 *
 * Runs:
 *   1. mcp_ctx_tool dist/install.js  (registers mcp_ctx_tool into opencode.json)
 *   2. mcp_ctx_summary dist/install.js  (registers mcp_ctx_summary into opencode.json)
 */

import { existsSync } from "fs"
import { execSync } from "child_process"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, "..")

const UNINSTALL = process.argv.includes("--uninstall")

function run(cmd: string, cwd: string, label: string): void {
  console.log(`\n[install-all] ${label}`)
  console.log(`  $ ${cmd}`)
  try {
    execSync(cmd, { cwd, stdio: "inherit" })
    console.log(`  ✓ ${label} done`)
  } catch (err) {
    console.error(`  ✗ ${label} failed`)
    process.exit(1)
  }
}

function install(): void {
  console.log("=== Installing all MCP servers ===\n")

  // 1. mcp_ctx_tool install
  const ctxToolInstallScript = resolve(ROOT, "mcps", "mcp_ctx_tool", "dist", "install.js")
  if (existsSync(ctxToolInstallScript)) {
    run(`node "${ctxToolInstallScript}"`, resolve(ROOT, "mcps", "mcp_ctx_tool"), "mcp_ctx_tool MCP")
  } else {
    console.warn("  ! mcp_ctx_tool install script not found, skipping (build it first: cd mcps/mcp_ctx_tool && npm run build)")
  }

  // 2. mcp_ctx_summary install
  const ctxSummaryInstallScript = resolve(ROOT, "mcps", "mcp_ctx_summary", "dist", "install.js")
  if (existsSync(ctxSummaryInstallScript)) {
    run(`node "${ctxSummaryInstallScript}"`, resolve(ROOT, "mcps", "mcp_ctx_summary"), "mcp_ctx_summary MCP")
  } else {
    console.warn("  ! mcp_ctx_summary install script not found, skipping (build it first: cd mcps/mcp_ctx_summary && npm run build)")
  }

  console.log("\n=== All done ===")
  console.log("Restart opencode to pick up the new MCP servers.")
}

function uninstall(): void {
  console.log("=== Uninstalling all MCP servers ===\n")

  const ctxToolInstallScript = resolve(ROOT, "mcps", "mcp_ctx_tool", "dist", "install.js")
  if (existsSync(ctxToolInstallScript)) {
    run(`node "${ctxToolInstallScript}" --uninstall`, resolve(ROOT, "mcps", "mcp_ctx_tool"), "mcp_ctx_tool MCP")
  }

  const ctxSummaryInstallScript = resolve(ROOT, "mcps", "mcp_ctx_summary", "dist", "install.js")
  if (existsSync(ctxSummaryInstallScript)) {
    run(`node "${ctxSummaryInstallScript}" --uninstall`, resolve(ROOT, "mcps", "mcp_ctx_summary"), "mcp_ctx_summary MCP")
  }

  console.log("\n=== All removed ===")
}

if (UNINSTALL) {
  uninstall()
} else {
  install()
}
