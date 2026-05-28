/**
 * Routing plugin — opencode plugin
 *
 * Tool routing, security policy, and shell guidance.
 * RTK rewrite lives in rtk.ts (separate plugin, loaded independently).
 *
 * Hooks:
 *   - tool.execute.before: routing decisions + security enforcement
 *   - tool.execute.after:  verbose logging (CTX_PLUGIN_VERBOSE=1)
 *   - shell.env:           inject CTX_PLUGIN_* environment variables
 *   - permission.ask:       auto-grant safe / deny dangerous commands
 *   - chat.message:        inject routing guidance into model context
 */

import * as fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { existsSync, readFileSync } from "node:fs"

const { readSync, openSync, closeSync, lstatSync, mkdirSync, constants: fsConstants } = fs

// ─────────────────────────────────────────────────────────────────────────────
// MCP ready detection
// ─────────────────────────────────────────────────────────────────────────────

function checkMcpReady(): boolean {
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

// ─────────────────────────────────────────────────────────────────────────────
// Routing hooks (lazy-loaded; optional enhancement)
// ─────────────────────────────────────────────────────────────────────────────

type RouteDecision = {
  action: string
  reason?: string
  updatedArgs?: Record<string, unknown>
  additionalContext?: string
}

type RouteContext = {
  tool: string
  args: Record<string, unknown>
  sessionId: string
  projectDir?: string
  mcpReady?: boolean
}

let _routeTool: ((ctx: RouteContext) => RouteDecision) | null | false = null
let _normalizeTool: ((name: string) => string) | null = null
let _isCtxPluginTool: ((name: string) => boolean) | null = null

async function getRouting() {
  if (_routeTool !== null) return
  _routeTool = false // sentinel: attempted but unavailable

  const candidates = [
    { routing: "./hooks/routing.js",       naming: "./hooks/tool-naming.js" },
    { routing: "../../ctx_plugin/src/hooks/routing.js",  naming: "../../ctx_plugin/src/hooks/tool-naming.js" },
  ]

  for (const { routing, naming } of candidates) {
    try {
      const routingMod = await import(/* @vite-ignore */ routing)
      const namingMod  = await import(/* @vite-ignore */ naming)
      if (routingMod.routeTool && namingMod.normalizeToolName) {
        _routeTool       = routingMod.routeTool
        _normalizeTool   = namingMod.normalizeToolName
        _isCtxPluginTool = namingMod.isCtxPluginTool
        return
      }
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool name normalization (inlined from hooks/tool-naming.ts)
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_ALIASES: Record<string, string> = {
  bash: "Bash", Bash: "Bash", shell: "Bash", Shell: "Bash",
  read: "Read", Read: "Read", read_file: "Read",
  grep: "Grep", Grep: "Grep",
  webfetch: "WebFetch", WebFetch: "WebFetch",
  agent: "Agent", Agent: "Agent",
  "ctx_": "ctx_",
}

function normalizeToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name
}

function isCtxPluginTool(name: string): boolean {
  return (
    name.startsWith("ctx_") ||
    name.startsWith("mcp__ctx_plugin__") ||
    name.startsWith("MCP:ctx_")
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Guidance (inlined from hooks/guidance.ts — all 8 types)
// ─────────────────────────────────────────────────────────────────────────────

type GuidanceType = "bash" | "read" | "grep" | "external-mcp" | "curl" | "webfetch" | "build-tool" | "large-output"

const GUIDANCE_MESSAGES: Record<GuidanceType, string> = {
  bash:         "ctx_plugin guidance: For multi-step bash, prefer ctx_execute for isolation. Large outputs auto-truncate at 100MB.",
  read:         "ctx_plugin guidance: For large file analysis (>50KB), ctx_execute_file provides sandboxed read with token estimation.",
  grep:         "ctx_plugin guidance: For multi-file search, ctx_execute enables sandboxed grep with parallel execution. Consider ctx_search.",
  "external-mcp": "ctx_plugin guidance: External MCP tools can flood context. Consider ctx_execute for structured tasks.",
  curl:         "ctx_plugin guidance: curl/wget piped to shell is risky. Use ctx_execute with fetch() for HTTP requests.",
  webfetch:     "ctx_plugin guidance: WebFetch is discouraged. Use ctx_execute with fetch() or ctx_index for web content.",
  "build-tool":  "ctx_plugin guidance: Build tools detected. Consider ctx_execute for isolated builds with timeout control.",
  "large-output": "ctx_plugin guidance: Large command output detected. ctx_execute truncates at 100MB. Consider ctx_batch_execute.",
}

function guidanceDir(sessionId: string): string {
  return path.join(os.tmpdir(), `ctx-plugin-guidance-${sessionId || String(process.ppid)}`)
}

const _shownInProcess = new Set<GuidanceType>()

function showGuidanceOnce(type: GuidanceType, sessionId: string): string | null {
  if (_shownInProcess.has(type)) return null
  const dir = guidanceDir(sessionId)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    _shownInProcess.add(type)
    return null
  }
  const marker = path.join(dir, type)
  try {
    openSync(marker, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600)
    closeSync(openSync(marker, fsConstants.O_RDONLY))
  } catch {
    _shownInProcess.add(type)
    return null
  }
  _shownInProcess.add(type)
  return GUIDANCE_MESSAGES[type] ?? null
}

function buildGuidanceContext(type: GuidanceType, sessionId: string): string | null {
  const msg = showGuidanceOnce(type, sessionId)
  return msg ? `[ctx_plugin guidance]: ${msg}` : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Security policy (inlined from security.ts; must stay in sync)
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_PATTERNS: RegExp[] = [
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

const DANGEROUS_PATTERNS: RegExp[] = [
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /rm\s+-rf\s+\/(?!proc|sys|dev)/,
  /\beval\s*\(/,
  /PYTHONSTARTUP/,
  /LD_PRELOAD/,
]

const DANGEROUS_ROUTING_PATTERNS: RegExp[] = [
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /\$\([^)]*\).*\|.*sh/i,
  /`[^`]*`.*\|.*sh/i,
]

function isSafeCommand(cmd: string): boolean {
  return SAFE_PATTERNS.some(rx => rx.test(cmd.trim()))
}

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(rx => rx.test(cmd))
}

function hasDangerousPattern(cmd: string): boolean {
  return DANGEROUS_ROUTING_PATTERNS.some(rx => rx.test(cmd))
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing decision (inlined from hooks/routing.ts)
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_COMMAND_PATTERNS: RegExp[] = [
  /^pwd$/, /^whoami$/, /^hostname(?:\s+-[a-zA-Z]+)?$/, /^uname(?:\s+-[a-zA-Z]+)?$/,
  /^id(?:\s+\S+)?$/, /^date(?:\s+[^\r\n]+)?$/, /^echo\s.*$/, /^printf\s.*$/,
  /^which\s+\S+/, /^type\s+\S+/, /^command\s+-v\s+\S+/,
  /^readlink(?:\s+[^\r\n]+)?$/, /^basename(?:\s+[^\r\n]+)?$/, /^dirname(?:\s+[^\r\n]+)?$/,
  /^realpath(?:\s+[^\r\n]+)?$/, /^cd(?:\s+[^\r\n]+)?$/,
  /^mkdir\s[^\r\n]+$/, /^touch\s[^\r\n]+$/,
  /^mv\s[^\r\n]+$/, /^cp\s[^\r\n]+$/, /^ln\s[^\r\n]+$/,
  /^ls(?!\s+-[a-zA-Z]*R)(?:\s+[^\r\n]+)?$/, /^cat\s[^\r\n]+$/, /^head\s[^\r\n]+$/,
  /^tail\s[^\r\n]+$/, /^wc\s[^\r\n]+$/, /^stat\s[^\r\n]+$/, /^file\s[^\r\n]+$/,
  /^git\s+(?:status|rev-parse|remote(?:\s+-v|\s+show\s+\S+)?|branch|config\s+--get|diff(?:\s+--stat|\s+--name-only)?|stash\s+list|tag|log|show|ls-files|ls-tree|cat-file|diff-index|hash-object|ls-remote|describe|name-rev|for-each-ref|archive|verify-commit|verify-tag)(?:\s+[^\r\n]+)?$/,
]

const UNBOUNDED_PATTERNS: RegExp[] = [
  /^npm\s+(install|run|pnpm\s+install|bun\s+install|yarn\s+add)(?:\s+|$)/,
  /^cargo\s+(build|test)(?:\s+|$)/,
  /^go\s+run(?:\s+|$)/,
  /^python\s+.*\.py(?:\s+|$)/,
]

const BUILD_TOOL_PATTERNS: RegExp[] = [
  /^npm\s+run(?:\s+(?!.*--help))/, /^pnpm\s+run/, /^yarn\s+run/, /^bun\s+run/,
  /^cargo\s+(?!env|which|version|help)/, /^go\s+(build|test)(?:\s+|$)/,
  /^make(?:\s+|$)/, /^cmake/, /^gradle/,
]

const SHELL_CONTROL_OPERATORS = /[|`\n\r]|\$\(|>>|>|<(?!<)|&(?!&)|&&|\|\||;/

function isStructurallyBounded(cmd: string): boolean {
  if (!cmd || SHELL_CONTROL_OPERATORS.test(cmd.trim())) return false
  return SAFE_COMMAND_PATTERNS.some(rx => rx.test(cmd.trim()))
}

function isUnboundedOutput(cmd: string): boolean {
  return UNBOUNDED_PATTERNS.some(rx => rx.test(cmd.trim()))
}

function isBuildTool(cmd: string): boolean {
  return BUILD_TOOL_PATTERNS.some(rx => rx.test(cmd.trim()))
}

function extractCommand(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command
  if (typeof args.command === "object" && args.command !== null) {
    const cmd = args.command as Record<string, unknown>
    if (typeof cmd.raw === "string") return cmd.raw
    if (typeof cmd.value === "string") return cmd.value
  }
  return ""
}

function routeBash(command: string, sessionId: string, mcpReady: boolean): RouteDecision {
  if (!command) return { action: "allow" }
  if (hasDangerousPattern(command)) {
    const guidance = buildGuidanceContext("curl", sessionId)
    return { action: "context", reason: "Dangerous pattern detected", additionalContext: guidance ?? undefined }
  }
  if (isStructurallyBounded(command)) return { action: "allow" }
  if (isBuildTool(command) && mcpReady) {
    const guidance = buildGuidanceContext("build-tool", sessionId)
    return { action: "context", additionalContext: guidance ?? undefined }
  }
  if (isUnboundedOutput(command) && mcpReady) {
    const guidance = buildGuidanceContext("large-output", sessionId)
    return { action: "context", additionalContext: guidance ?? undefined }
  }
  if (mcpReady) {
    const guidance = buildGuidanceContext("bash", sessionId)
    return { action: "context", additionalContext: guidance ?? undefined }
  }
  return { action: "allow" }
}

function routeTool(tool: string, args: Record<string, unknown>, sessionId: string, mcpReady: boolean): RouteDecision {
  const normalized = normalizeToolName(tool)
  if (isCtxPluginTool(normalized)) return { action: "allow" }

  switch (normalized) {
    case "Bash": return routeBash(extractCommand(args), sessionId, mcpReady)
    case "Grep": {
      if (mcpReady) {
        const g = buildGuidanceContext("grep", sessionId)
        return { action: "context", additionalContext: g ?? undefined }
      }
      return { action: "allow" }
    }
    case "WebFetch": {
      const g = buildGuidanceContext("webfetch", sessionId)
      return { action: "context", additionalContext: g ?? "ctx_plugin guidance: WebFetch is discouraged. Use ctx_execute with fetch() instead." }
    }
    case "Read": {
      const pathVal = args.path as string | undefined
      if (pathVal && mcpReady) {
        const largeIndicators = [/\.min\.(js|css)$/, /node_modules/, /\.log$/, /\.sqlite/, /dist\//, /build\//]
        if (largeIndicators.some(rx => rx.test(pathVal))) {
          const g = buildGuidanceContext("read", sessionId)
          return { action: "context", additionalContext: g ?? undefined }
        }
      }
      return { action: "allow" }
    }
    default:
      return { action: "allow" }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin factory
// ─────────────────────────────────────────────────────────────────────────────

export const RoutingPlugin = async (input) => {
  const mcpReady = checkMcpReady()
  // Kick off routing hooks init in background; don't await — they're an enhancement
  getRouting().catch(() => {})

  const sessionId = String(input.sessionID ?? input.sessionId ?? process.pid)

  return {
    // Routing decision + security enforcement for all tool calls
    "tool.execute.before": async (input, output) => {
      const tool = String(input.tool ?? "").toLowerCase()
      const args = (output.args ?? {}) ?? {}

      if (_routeTool && _normalizeTool && _isCtxPluginTool) {
        const normalized = _normalizeTool(tool)
        if (!_isCtxPluginTool(normalized)) {
          try {
            const decision = _routeTool({ tool, args, sessionId, projectDir: input.directory ?? input.worktree, mcpReady })

            if (decision.action === "deny") {
              throw new Error(`[ctx_plugin routing] ${decision.reason ?? "blocked by security policy"}`)
            }
            if (decision.action === "context" && decision.additionalContext) {
              output.context = output.context ?? {}
              if (typeof output.context === "object" && output.context !== null) {
                ;(output.context as Record<string, unknown>).__ctxPluginGuidance = decision.additionalContext
              }
            }
            if (decision.action === "modify" && decision.updatedArgs) {
              Object.assign(args, decision.updatedArgs)
            }
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("[ctx_plugin routing]")) throw err
          }
        }
      } else {
        // Fallback: inline routing when hooks unavailable
        const decision = routeTool(tool, args, sessionId, mcpReady)
        if (decision.action === "deny") {
          throw new Error(`[ctx_plugin routing] ${decision.reason ?? "blocked by security policy"}`)
        }
        if (decision.action === "context" && decision.additionalContext) {
          output.context = output.context ?? {}
          if (typeof output.context === "object" && output.context !== null) {
            ;(output.context as Record<string, unknown>).__ctxPluginGuidance = decision.additionalContext
          }
        }
      }
    },

    // Verbose tool execution logging
    "tool.execute.after": async (input, output) => {
      if (process.env.CTX_PLUGIN_VERBOSE === "1") {
        const tool = String(input.tool ?? "")
        const args = (input.args ?? {}) ?? {}
        const title = output.title ?? tool
        const outputText = typeof output.output === "string"
          ? output.output.slice(0, 200)
          : String(output.output).slice(0, 200)
        console.error(`[ctx_plugin] tool: ${title}, args: ${JSON.stringify(args).slice(0, 100)}, output: ${outputText}...`)
      }
    },

    // Inject CTX_PLUGIN_* into all shell sessions
    "shell.env": async (input, output) => {
      output.env = output.env ?? {}
      output.env["CTX_PLUGIN_VERSION"] = "0.3.0"
      output.env["CTX_PLUGIN_MCP_READY"] = mcpReady ? "1" : "0"
      if (input.directory) {
        output.env["CTX_PROJECT_DIR"] = input.directory
      }
    },

    // Permission gate: auto-grant safe, deny dangerous
    "permission.ask": async (input, output) => {
      const perm = input as { permission?: { type?: string; command?: string } }
      const ptype = perm.permission?.type ?? ""
      const pcmd = perm.permission?.command ?? ""

      if (ptype === "bash" || ptype === "shell") {
        if (isDangerousCommand(pcmd)) { output.status = "deny"; return }
        if (isSafeCommand(pcmd)) { output.status = "allow"; return }
      }

      output.status = "ask"
    },

    // Inject guidance from routing decision into model context
    "chat.message": async (input, output) => {
      if (output.context) {
        const ctx = output.context as Record<string, unknown>
        if (ctx.__ctxPluginGuidance) {
          output.parts.push({ type: "text", text: "\n\n" + String(ctx.__ctxPluginGuidance) })
        }
      }
    },
  }
}

export default RoutingPlugin
