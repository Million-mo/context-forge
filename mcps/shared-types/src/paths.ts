/**
 * Shared path resolution for Context Forge.
 *
 * Single source of truth for all config/data/plugin directories.
 * Every other file should import from here — never inline the XDG logic.
 *
 * Directory layout:
 *
 *   ~/.ctx_plugin/                Global config + data (XDG-compliant)
 *   ├── config.json               Shared global defaults
 *   ├── caveman-active            Caveman runtime flag
 *   └── data/
 *       └── sessions/             Session event SQLite
 *
 *   <project>/.ctx_plugin/        Project-level overrides
 *   ├── config.json               Per-project config
 *   └── data/
 *       ├── summaries.db          LLM turn summaries
 *       └── content.db            FTS5 content index
 */

import { homedir } from "node:os"
import { resolve } from "node:path"

const isWin = process.platform === "win32"

// ─────────────────────────────────────────────────────────
// Global config directory: ~/.ctx_plugin/
// ─────────────────────────────────────────────────────────

export function getGlobalConfigDir(): string {
  if (process.env.CTX_PLUGIN_CONFIG_DIR) {
    return resolve(process.env.CTX_PLUGIN_CONFIG_DIR)
  }
  if (process.env.XDG_CONFIG_HOME) {
    return resolve(process.env.XDG_CONFIG_HOME, "ctx_plugin")
  }
  if (isWin) {
    return resolve(
      process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"),
      "ctx_plugin"
    )
  }
  return resolve(homedir(), ".config", "ctx_plugin")
}

// ─────────────────────────────────────────────────────────
// Global data directory: ~/.local/share/ctx_plugin/
// ─────────────────────────────────────────────────────────

export function getGlobalDataDir(): string {
  if (process.env.CTX_PLUGIN_DATA_DIR) {
    return resolve(process.env.CTX_PLUGIN_DATA_DIR)
  }
  if (process.env.XDG_DATA_HOME) {
    return resolve(process.env.XDG_DATA_HOME, "ctx_plugin")
  }
  if (isWin) {
    return resolve(
      process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"),
      "ctx_plugin"
    )
  }
  return resolve(homedir(), ".local", "share", "ctx_plugin")
}

// ─────────────────────────────────────────────────────────
// OpenCode plugins directory (for build/install)
// ─────────────────────────────────────────────────────────

export function getOpenCodePluginsDir(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME && resolve(process.env.XDG_CONFIG_HOME, "opencode")) ||
    (isWin
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "opencode")
      : resolve(homedir(), ".config", "opencode"))
  return resolve(configDir, "plugins")
}

// ─────────────────────────────────────────────────────────
// Project-level config directory: <cwd>/.ctx_plugin/
// ─────────────────────────────────────────────────────────

export function getProjectConfigDir(projectDir?: string): string {
  return resolve(projectDir || process.cwd(), ".ctx_plugin")
}

// ─────────────────────────────────────────────────────────
// Project-level data directory: <cwd>/.ctx_plugin/data/
// ─────────────────────────────────────────────────────────

export function getProjectDataDir(projectDir?: string): string {
  return resolve(getProjectConfigDir(projectDir), "data")
}

// ─────────────────────────────────────────────────────────
// Config file paths
// ─────────────────────────────────────────────────────────

export function getGlobalConfigPath(): string {
  return resolve(getGlobalConfigDir(), "config.json")
}

export function getProjectConfigPath(projectDir?: string): string {
  return resolve(getProjectConfigDir(projectDir), "config.json")
}

export function getCavemanFlagPath(): string {
  return resolve(getGlobalConfigDir(), "caveman-active")
}

// ─────────────────────────────────────────────────────────
// Database paths
// ─────────────────────────────────────────────────────────

export function getSummariesDbPath(projectDir?: string): string {
  return resolve(getProjectDataDir(projectDir), "summaries.db")
}

export function getContentDbPath(projectDir?: string): string {
  return resolve(getProjectDataDir(projectDir), "content.db")
}

export function getSessionsDir(): string {
  return resolve(getGlobalDataDir(), "sessions")
}
