/**
 * CLI for registering ctx_summary_mcp in opencode.json MCP config.
 *
 * Usage:
 *   node dist/install.js       (register)
 *   node dist/install.js --uninstall  (remove)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

interface OpencodeMcpEntry {
  type?: string
  command?: string[]
  env?: Record<string, string>
}

interface OpencodeConfig {
  mcp?: Record<string, OpencodeMcpEntry>
  plugins?: string[]
}

function getOpencodeConfigPath(): string {
  const home = process.env.HOME || ""
  const xdg = process.env.XDG_CONFIG_HOME || resolve(home, ".config")
  return resolve(xdg, "opencode", "opencode.json")
}

function ensureConfigDir(): void {
  const configPath = getOpencodeConfigPath()
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function loadOpencodeConfig(): OpencodeConfig {
  const configPath = getOpencodeConfigPath()
  if (!existsSync(configPath)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"))
  } catch {
    return {}
  }
}

function saveOpencodeConfig(config: OpencodeConfig): void {
  ensureConfigDir()
  const configPath = getOpencodeConfigPath()
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`[ctx_summary_mcp] Updated ${configPath}`)
}

function getServerPath(): string {
  return resolve(__dirname, "server.js")
}

function install(): void {
  const config = loadOpencodeConfig()
  if (!config.mcp) config.mcp = {}

  config.mcp["ctx_summary_mcp"] = {
    type: "local",
    command: ["node", getServerPath()],
  }

  saveOpencodeConfig(config)
  console.log("[ctx_summary_mcp] Installed successfully")
  console.log("Restart opencode to pick up the new MCP server.")
}

function uninstall(): void {
  const config = loadOpencodeConfig()
  if (config.mcp?.["ctx_summary_mcp"]) {
    delete config.mcp["ctx_summary_mcp"]
  }
  saveOpencodeConfig(config)
  console.log("[ctx_summary_mcp] Uninstalled successfully")
}

const args = process.argv.slice(2)
if (args.includes("--uninstall")) {
  uninstall()
} else {
  install()
}
