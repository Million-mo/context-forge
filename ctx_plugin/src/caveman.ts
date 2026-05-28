/**
 * Caveman plugin — opencode plugin
 *
 * Ultra-compressed communication mode with:
 *   - Session init: writes .caveman-active flag on startup
 *   - Mode tracking: parses /caveman slash commands and natural language
 *   - Reinforcement: appends per-turn reminder when active
 *   - Skill loading: filters SKILL.md content by active intensity level
 *
 * Source of truth lives here. Mirror to .opencode/plugins/caveman.mjs for runtime.
 * Run bin/build-plugins.mjs to regenerate.
 */

import * as fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { existsSync, unlinkSync } from "node:fs"

const { mkdirSync, lstatSync, realpathSync, statSync, openSync, writeSync, closeSync, renameSync, readFileSync, readSync } = fs

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VALID_MODES = new Set([
  "off", "lite", "full", "ultra",
  "wenyan-lite", "wenyan", "wenyan-full", "wenyan-ultra",
  "commit", "review", "compress",
])

const INDEPENDENT_MODES = new Set(["commit", "review", "compress"])

const CAVEMAN_FLAG = (() => {
  const base = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, "opencode")) ||
    (process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode")
      : path.join(os.homedir(), ".config", "opencode"))
  return path.join(base, ".caveman-active")
})()

const CAVEMAN_CONFIG_DIR = (() => {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "caveman")
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "caveman")
  }
  return path.join(os.homedir(), ".config", "caveman")
})()

const CAVEMAN_CONFIG_FILE = path.join(CAVEMAN_CONFIG_DIR, "config.json")

// ---------------------------------------------------------------------------
// Flag I/O
// ---------------------------------------------------------------------------

function getDefaultMode() {
  const env = process.env.CAVEMAN_DEFAULT_MODE
  if (env && VALID_MODES.has(env.toLowerCase())) return env.toLowerCase()
  try {
    const cfg = JSON.parse(readFileSync(CAVEMAN_CONFIG_FILE, "utf8"))
    if (cfg.defaultMode && VALID_MODES.has(cfg.defaultMode.toLowerCase())) {
      return cfg.defaultMode.toLowerCase()
    }
  } catch {}
  return "full"
}

function safeWriteFlag(flagPath, content) {
  try {
    const flagDir = path.dirname(flagPath)
    mkdirSync(flagDir, { recursive: true })

    let realFlagDir = flagDir
    try {
      const lstat = lstatSync(flagDir)
      if (lstat.isSymbolicLink()) {
        realFlagDir = realpathSync(flagDir)
        const st = statSync(realFlagDir)
        if (!st.isDirectory()) return
        if (typeof process.getuid === "function" && st.uid !== process.getuid()) return
      }
    } catch { return }

    const realFlagPath = path.join(realFlagDir, path.basename(flagPath))
    try {
      if (lstatSync(realFlagPath).isSymbolicLink()) return
    } catch (e) {
      if (e.code !== "ENOENT") return
    }

    const tmp = path.join(realFlagDir, `.caveman-tmp.${process.pid}.${Date.now()}`)
    const O_NOFOLLOW = (fs.constants?.O_NOFOLLOW ?? 0)
    const fd = openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600)
    writeSync(fd, content)
    closeSync(fd)
    renameSync(tmp, realFlagPath)
  } catch {}
}

function readFlag(flagPath) {
  try {
    const st = lstatSync(flagPath)
    if (st.isSymbolicLink() || !st.isFile()) return null
    if (st.size > 64) return null
    const O_NOFOLLOW = (fs.constants?.O_NOFOLLOW ?? 0)
    const fd = openSync(flagPath, fs.constants.O_RDONLY | O_NOFOLLOW)
    const buf = Buffer.alloc(64)
    const n = readSync(fd, buf, 0, 64, 0)
    closeSync(fd)
    const raw = buf.slice(0, n).toString("utf8").trim()
    return VALID_MODES.has(raw) ? raw : null
  } catch { return null }
}

function applyDefaultMode() {
  const mode = getDefaultMode()
  if (mode === "off") {
    try { if (existsSync(CAVEMAN_FLAG)) unlinkSync(CAVEMAN_FLAG) } catch {}
  } else {
    safeWriteFlag(CAVEMAN_FLAG, mode)
  }
}

// ---------------------------------------------------------------------------
// Mode parsing
// ---------------------------------------------------------------------------

function reinforcementLine(mode) {
  return (
    `CAVEMAN MODE ACTIVE (${mode}). ` +
    "Drop articles/filler/pleasantries/hedging. Fragments OK. " +
    "Code/commits/security: write normal."
  )
}

function parseModeChange(prompt) {
  const p = (prompt || "").trim().toLowerCase()
  if (!p) return null

  if (
    /\b(stop|disable|deactivate|turn off)\b.*\bcaveman\b/i.test(p) ||
    /\bcaveman\b.*\b(stop|disable|deactivate|turn off)\b/i.test(p) ||
    /\bnormal mode\b/i.test(p)
  ) return "off"

  if (
    /\b(activate|enable|turn on|start|talk like)\b.*\bcaveman\b/i.test(p) ||
    /\bcaveman\b.*\b(mode|activate|enable|turn on|start)\b/i.test(p)
  ) {
    const m = getDefaultMode()
    return m === "off" ? null : m
  }

  if (p.startsWith("/caveman")) {
    const parts = p.split(/\s+/)
    const cmd = parts[0]
    const arg = parts[1] || ""

    if (cmd === "/caveman-commit") return "commit"
    if (cmd === "/caveman-review") return "review"
    if (cmd === "/caveman-compress") return "compress"

    if (cmd === "/caveman") {
      if (!arg) return getDefaultMode()
      if (arg === "off" || arg === "stop" || arg === "disable") return "off"
      if (arg === "wenyan-full") return "wenyan"
      if (VALID_MODES.has(arg) && !INDEPENDENT_MODES.has(arg)) return arg
      return null
    }
  }

  return null
}

function applyModeChange(mode) {
  if (!mode) return
  if (mode === "off") {
    try { if (existsSync(CAVEMAN_FLAG)) unlinkSync(CAVEMAN_FLAG) } catch {}
    return
  }
  safeWriteFlag(CAVEMAN_FLAG, mode)
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const CavemanPlugin = async (input) => {
  return {
    // One-shot initialization on session start
    "session.created": async () => {
      applyDefaultMode()
    },

    // Every user message: parse mode changes + reinforce if active
    "chat.message": async (input, output) => {
      const parts = output.parts
      let promptText = ""
      for (const part of parts) {
        if (part.type === "text") promptText += part.text ?? ""
      }

      const change = parseModeChange(promptText)
      if (change) applyModeChange(change)

      const active = readFlag(CAVEMAN_FLAG)
      if (active && !INDEPENDENT_MODES.has(active)) {
        parts.push({ type: "text", text: "\n\n" + reinforcementLine(active) })
      }
    },
  }
}

export default CavemanPlugin
