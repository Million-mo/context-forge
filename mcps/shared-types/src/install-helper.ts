/**
 * install-helper.ts — OpenCode MCP install/uninstall helpers
 *
 * Shared by mcp_ctx_tool and mcp_ctx_summary install scripts.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { resolve, dirname } from "path"

export interface OpencodeMcpEntry {
  type?: string
  command?: string[]
  env?: Record<string, string>
}

export interface OpencodeConfig {
  mcp?: Record<string, OpencodeMcpEntry>
  plugins?: string[]
}

export function getOpencodeConfigPath(): string {
  const home = process.env.HOME || ""
  const xdg = process.env.XDG_CONFIG_HOME || resolve(home, ".config")
  return resolve(xdg, "opencode", "opencode.json")
}

export function ensureConfigDir(): void {
  const configPath = getOpencodeConfigPath()
  const dir = dirname(configPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function loadOpencodeConfig(): OpencodeConfig {
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

export function saveOpencodeConfig(config: OpencodeConfig, label: string): void {
  ensureConfigDir()
  const configPath = getOpencodeConfigPath()
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`[${label}] Updated ${configPath}`)
}

export function registerMcp(logLabel: string, serverName: string, serverPath: string): void {
  const config = loadOpencodeConfig()
  if (!config.mcp) config.mcp = {}

  config.mcp[serverName] = {
    type: "local",
    command: ["node", serverPath],
  }

  saveOpencodeConfig(config, logLabel)
  console.log(`[${logLabel}] Installed successfully`)
  console.log("Restart opencode to pick up the new MCP server.")
}

export function unregisterMcp(logLabel: string, serverName: string): void {
  const config = loadOpencodeConfig()
  if (config.mcp?.[serverName]) {
    delete config.mcp[serverName]
  }
  saveOpencodeConfig(config, logLabel)
  console.log(`[${logLabel}] Uninstalled successfully`)
}
