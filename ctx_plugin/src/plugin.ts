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
// Routing & Security (new)
// ---------------------------------------------------------------------------

// Lazy imports to avoid circular deps
let _routeTool: ((ctx: { tool: string; args: Record<string, unknown>; sessionId: string; projectDir?: string; mcpReady?: boolean }) => { action: string; reason?: string; updatedArgs?: Record<string, unknown>; additionalContext?: string }) | null = null
let _normalizeTool: ((name: string) => string) | null = null
let _isCtxPluginTool: ((name: string) => boolean) | null = null

async function getRouting() {
  if (!_routeTool) {
    try {
      const routingMod = await import("./hooks/routing.js")
      const namingMod = await import("./hooks/tool-naming.js")
      _routeTool = routingMod.routeTool
      _normalizeTool = namingMod.normalizeToolName
      _isCtxPluginTool = namingMod.isCtxPluginTool
    } catch {
      // Routing not available — fail silently
    }
  }
}

function checkMcpReady(): boolean {
  // Detect if ctx_plugin MCP server is configured
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME && path.join(process.env.XDG_CONFIG_HOME, "opencode")) ||
    (process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "opencode")
      : path.join(os.homedir(), ".config", "opencode"))
  try {
    const configPath = path.join(configDir, "opencode.json")
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"))
      if (cfg?.mcp?.ctx_plugin) return true
    }
  } catch {}
  return false
}

// Safe command patterns for permission.ask auto-grant
const SAFE_PATTERNS = [
  /^git\s+(status|diff|log|branch|remote|tag|stash|pull|push)/,
  /^npm\s+(install|run|test|build|ci|outdated)/,
  /^pnpm\s+/,
  /^yarn\s+/,
  /^bun\s+/,
  /^cargo\s+/,
  /^go\s+(run|build|test|get)/,
  /^ls(?!\s+-[a-zA-Z]*R)/,
  /^pwd$/,
  /^whoami$/,
  /^echo\s/,
  /^mkdir\s/,
  /^touch\s/,
  /^cat\s/,
  /^grep\s/,
]

const DANGEROUS_PATTERNS = [
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /rm\s+-rf\s+\/(?!proc|sys|dev)/,
  /\beval\s*\(/,
  /PYTHONSTARTUP/,
  /LD_PRELOAD/,
]

function isSafeCommand(cmd: string): boolean {
  return SAFE_PATTERNS.some(rx => rx.test(cmd.trim()))
}

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(rx => rx.test(cmd))
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const CtxPlugin = async (input) => {
  const $ = input.$
  const rtkAvailable = await checkRtkAvailable($)
  const mcpReady = checkMcpReady()
  await getRouting()

  // Session-init guard — runs once on first chat.message
  let sessionInitialized = false

  // Session ID (stable across hooks)
  const sessionId = String(input.sessionID ?? input.sessionId ?? process.pid)

  return {
    // RTK + Security + Guidance: rewrite bash/shell before execution
    "tool.execute.before": async (input, output) => {
      const tool = String(input.tool ?? "").toLowerCase()
      const args = (output.args ?? {}) ?? {}

      // Use routing for all tools (not just bash/shell)
      if (_routeTool && _normalizeTool && _isCtxPluginTool) {
        const normalized = _normalizeTool(String(input.tool ?? ""))
        if (!_isCtxPluginTool(normalized)) {
          const decision = _routeTool({
            tool: String(input.tool ?? ""),
            args,
            sessionId,
            projectDir: input.directory ?? input.worktree,
            mcpReady,
          })

          if (decision.action === "deny") {
            // Block execution by throwing
            throw new Error(`[ctx_plugin security] ${decision.reason ?? "blocked by security policy"}`)
          }

          if (decision.action === "context" && decision.additionalContext) {
            // Inject guidance into output context (opencode may render this)
            output.context = output.context ?? {}
            if (typeof output.context === "object" && output.context !== null) {
              ;(output.context as Record<string, unknown>).__ctxPluginGuidance = decision.additionalContext
            }
          }

          if (decision.action === "modify" && decision.updatedArgs) {
            Object.assign(args, decision.updatedArgs)
          }
        }
      }

      // RTK rewrite: only for bash/shell commands
      if (tool === "bash" || tool === "shell") {
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
      }
    },

    // tool.execute.after: capture results for SessionDB (future use)
    "tool.execute.after": async (input, output) => {
      const tool = String(input.tool ?? "").toLowerCase()
      // TODO: wire to SessionDB once Phase 4 is implemented
      // For now, this hook is available for future event capture
      if (process.env.CTX_PLUGIN_VERBOSE === "1") {
        const args = (input.args ?? {}) ?? {}
        const title = output.title ?? tool
        const outputText = typeof output.output === "string" ? output.output.slice(0, 200) : String(output.output).slice(0, 200)
        console.error(`[ctx_plugin] tool: ${title}, args: ${JSON.stringify(args).slice(0, 100)}, output: ${outputText}...`)
      }
    },

    // shell.env: inject ctx_* environment variables into all shells
    "shell.env": async (input, output) => {
      output.env = output.env ?? {}
      output.env["CTX_PLUGIN_VERSION"] = "0.2.0"
      output.env["CTX_PLUGIN_RTK_AVAILABLE"] = rtkAvailable ? "1" : "0"
      output.env["CTX_PLUGIN_MCP_READY"] = mcpReady ? "1" : "0"
      if (input.directory) {
        output.env["CTX_PROJECT_DIR"] = input.directory
      }
    },

    // permission.ask: auto-grant safe commands, deny dangerous ones
    "permission.ask": async (input, output) => {
      const perm = input as { permission?: { type?: string; command?: string } }
      const ptype = perm.permission?.type ?? ""
      const pcmd = perm.permission?.command ?? ""

      if (ptype === "bash" || ptype === "shell") {
        if (isDangerousCommand(pcmd)) {
          output.status = "deny"
          return
        }
        if (isSafeCommand(pcmd)) {
          output.status = "allow"
          return
        }
      }

      // Default: ask the user
      output.status = "ask"
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

      // Inject routing guidance context if available
      if (_routeTool && output.context) {
        const ctx = output.context as Record<string, unknown>
        if (ctx.__ctxPluginGuidance) {
          parts.push({ type: "text", text: "\n\n" + String(ctx.__ctxPluginGuidance) })
        }
      }
    },

    // event: passthrough for future event types
    // (session.created is handled by the dedicated hook above)
    "event": async (input) => {
      // Reserved for future event routing
    },
  }
}

export default CtxPlugin
