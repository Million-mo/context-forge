/**
 * ctx_plugin — unified opencode plugin
 *
 * Merges two capabilities into one:
 *   - RTK: intercepts bash/shell tool calls and rewrites commands via `rtk rewrite`
 *   - Caveman: ultra-compressed communication mode with session init, mode tracking,
 *     slash-command parsing, and per-turn reinforcement
 *
 * Source of truth lives here. Mirror to .opencode/plugins/caveman.mjs for runtime.
 */

import * as fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { existsSync, unlinkSync } from "node:fs"

const { mkdirSync, lstatSync, realpathSync, statSync, openSync, writeSync, closeSync, renameSync, readFileSync, readSync } = fs

// ---------------------------------------------------------------------------
// RTK
// ---------------------------------------------------------------------------

async function checkRtkAvailable($) {
  try { await $`which rtk`.quiet(); return true } catch { return false }
}

// ---------------------------------------------------------------------------
// Caveman config
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

/**
 * Load and filter caveman SKILL.md content for the active intensity level.
 * Returns the filtered ruleset or null if file not found.
 */
function loadSkillContent(mode) {
  // Try to find SKILL.md relative to plugin location
  const possiblePaths = [
    path.join(process.cwd(), "ctx_plugin", "skills", "caveman", "SKILL.md"),
    path.join(__dirname, "..", "skills", "caveman", "SKILL.md"),
    path.join(os.homedir(), ".config", "opencode", "skills", "caveman", "SKILL.md"),
  ]

  let skillContent = ""
  for (const p of possiblePaths) {
    try {
      if (existsSync(p)) {
        skillContent = readFileSync(p, "utf8")
        break
      }
    } catch {}
  }

  if (!skillContent) return null

  // Strip YAML frontmatter
  const body = skillContent.replace(/^---\n[\s\S]*?\n---\n?/, "")

  // Resolve wenyan alias
  const modeLabel = mode === "wenyan" ? "wenyan-full" : mode

  // Filter intensity table: keep header rows + only the active level's row
  const filtered = body.split("\n").reduce((acc, line) => {
    // Table rows: | **level** |
    const tableRowMatch = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/)
    if (tableRowMatch) {
      if (tableRowMatch[1] === modeLabel) {
        acc.push(line)
      }
      return acc
    }

    // Example lines: "- level:"
    const exampleMatch = line.match(/^- (\S+?):\s/)
    if (exampleMatch) {
      if (exampleMatch[1] === modeLabel) {
        acc.push(line)
      }
      return acc
    }

    acc.push(line)
    return acc
  }, [])

  return filtered.join("\n")
}

function getActivationMessage(mode) {
  const modeLabel = mode === "wenyan" ? "wenyan-full" : mode

  // Independent modes (commit, review, compress) have their own skill behavior
  if (INDEPENDENT_MODES.has(mode)) {
    return `CAVEMAN MODE ACTIVE — level: ${mode}. Behavior defined by /caveman-${mode} skill.`
  }

  // Try to load skill content
  const skillContent = loadSkillContent(mode)
  if (skillContent) {
    return `CAVEMAN MODE ACTIVE — level: ${modeLabel}\n\n${skillContent}`
  }

  // Fallback when SKILL.md not found
  return (
    `CAVEMAN MODE ACTIVE — level: ${modeLabel}\n\n` +
    "Respond terse like smart caveman. All technical substance stay. Only fluff die.\n\n" +
    "## Persistence\n\n" +
    "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure. " +
    "Off only: \"stop caveman\" / \"normal mode\".\n\n" +
    "Current level: **" + modeLabel + "**. Switch: `/caveman lite|full|ultra`.\n\n" +
    "## Rules\n\n" +
    "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), " +
    "pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK. " +
    "Short synonyms (big not extensive, fix not \"implement a solution for\"). " +
    "Technical terms exact. Code blocks unchanged. Errors quoted exact.\n\n" +
    "Pattern: `[thing] [action] [reason]. [next step].`\n\n" +
    'Not: "Sure! I\'d be happy to help you with that. The issue you\'re experiencing..."\n' +
    'Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"\n\n' +
    "## Auto-Clarity\n\n" +
    "Drop caveman for: security warnings, irreversible action confirmations, " +
    "multi-step sequences where fragment order risks misread, " +
    "user asks to clarify or repeats question. Resume caveman after clear part done.\n\n" +
    "## Boundaries\n\n" +
    "Code/commits/PRs: write normal. \"stop caveman\" or \"normal mode\": revert. " +
    "Level persist until changed or session end."
  )
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const CtxPlugin = async (input) => {
  const $ = input.$
  const rtkAvailable = await checkRtkAvailable($)

  // Session-init guard — runs once on first chat.message
  let sessionInitialized = false

  return {
    // RTK: rewrite bash/shell commands before execution
    "tool.execute.before": async (input, output) => {
      const tool = String(input.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      const args = (output.args ?? {}) ?? {}
      if (!args.command) return
      const command = String(args.command)
      if (!command) return

      if (rtkAvailable) {
        try {
          const result = await $`rtk rewrite ${command}`.quiet().nothrow()
          const rewritten = String(result.stdout).trim()
          if (rewritten && rewritten !== command) {
            args.command = rewritten
          }
        } catch {}
      }
    },

    // Session created — fires on opencode startup. Initialize caveman mode.
    "session.created": async () => {
      const mode = getDefaultMode()
      if (mode === "off") {
        try { if (existsSync(CAVEMAN_FLAG)) unlinkSync(CAVEMAN_FLAG) } catch {}
        return
      }
      safeWriteFlag(CAVEMAN_FLAG, mode)
    },

    // Caveman: fires on every user message.
    // - Session init: write flag on first message
    // - Mode change: detect /caveman and update flag
    // - Reinforcement: append caveman reminder if mode is active
    "chat.message": async (input, output) => {
      // Session init — runs once
      if (!sessionInitialized) {
        sessionInitialized = true
        const mode = getDefaultMode()
        if (mode === "off") {
          try { if (existsSync(CAVEMAN_FLAG)) unlinkSync(CAVEMAN_FLAG) } catch {}
        } else {
          safeWriteFlag(CAVEMAN_FLAG, mode)
        }
      }

      // Extract text from message parts
      const parts = output.parts
      let promptText = ""
      for (const part of parts) {
        if (part.type === "text") promptText += part.text ?? ""
      }

      // Parse and apply mode changes
      const change = parseModeChange(promptText)
      if (change) applyModeChange(change)

      // Reinforcement — append if caveman is active (skip for independent modes)
      const active = readFlag(CAVEMAN_FLAG)
      if (active && !INDEPENDENT_MODES.has(active)) {
        parts.push({ type: "text", text: "\n\n" + reinforcementLine(active) })
      }
    },
  }
}

export default CtxPlugin
