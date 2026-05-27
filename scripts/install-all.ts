/**
 * One-shot installer for all MCP servers.
 *
 * Usage:
 *   npx tsx scripts/install-all.ts        (install all)
 *   npx tsx scripts/install-all.ts --uninstall  (remove all)
 *
 * Runs:
 *   1. ctx_plugin install mcp  (ctx_plugin's own CLI)
 *   2. services/ctx_summary_mcp/dist/install.js  (installs ctx_summary_mcp into opencode.json)
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

  // 1. ctx_plugin MCP
  const ctxPluginPkg = resolve(ROOT, "ctx_plugin", "package.json")
  if (existsSync(ctxPluginPkg)) {
    // ctx_plugin CLI is at dist/cli.js, or can be run via npx from ctx_plugin dir
    run("ctx_plugin install mcp", resolve(ROOT, "ctx_plugin"), "ctx_plugin MCP")
  } else {
    console.warn("  ! ctx_plugin not found, skipping")
  }

  // 2. ctx_summary_mcp install
  const summaryInstallScript = resolve(ROOT, "services", "ctx_summary_mcp", "dist", "install.js")
  if (existsSync(summaryInstallScript)) {
    run(`node "${summaryInstallScript}"`, resolve(ROOT, "services", "ctx_summary_mcp"), "ctx_summary_mcp MCP")
  } else {
    console.warn("  ! ctx_summary_mcp install script not found, skipping (build it first: cd services/ctx_summary_mcp && npm run build)")
  }

  console.log("\n=== All done ===")
  console.log("Restart opencode to pick up the new MCP servers.")
}

function uninstall(): void {
  console.log("=== Uninstalling all MCP servers ===\n")

  const ctxPluginPkg = resolve(ROOT, "ctx_plugin", "package.json")
  if (existsSync(ctxPluginPkg)) {
    run("ctx_plugin uninstall mcp", resolve(ROOT, "ctx_plugin"), "ctx_plugin MCP")
  }

  const summaryInstallScript = resolve(ROOT, "services", "ctx_summary_mcp", "dist", "install.js")
  if (existsSync(summaryInstallScript)) {
    run(`node "${summaryInstallScript}" --uninstall`, resolve(ROOT, "services", "ctx_summary_mcp"), "ctx_summary_mcp MCP")
  }

  console.log("\n=== All removed ===")
}

if (UNINSTALL) {
  uninstall()
} else {
  install()
}
