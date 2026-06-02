/**
 * Routing plugin — opencode plugin
 *
 * Tool routing, security policy, and shell guidance.
 * Uses hooks/routing.ts for core routing logic.
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
import { normalizeToolName, isCtxPluginTool } from "./hooks/tool-naming.js"
import { buildGuidanceContext } from "./hooks/guidance.js"
import { routeTool, ROUTING_BLOCK, type RouteDecision, type RouteContext } from "./hooks/routing.js"

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
      if (cfg?.mcp?.ctx_plugin || cfg?.mcp?.mcp_context_forge) return true
    }
  } catch {}
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing hooks (lazy-loaded for standalone .mjs runtime)
// When compiled via build-plugins.mjs, hook modules are copied alongside
// the plugin file, so the first candidate path should resolve.
// ─────────────────────────────────────────────────────────────────────────────

type LazyRouteTool = (ctx: RouteContext) => RouteDecision

let _routeTool: LazyRouteTool | null | false = null
let _normalizeTool: ((name: string) => string) | null = null
let _isCtxPluginTool: ((name: string) => boolean) | null = null

async function getRouting() {
  if (_routeTool !== null) return
  _routeTool = false // sentinel: attempted but unavailable

  const candidates = [
    { routing: "./hooks/routing.js",       naming: "./hooks/tool-naming.js" },
    { routing: "../../ctx_plugin/dist/hooks/routing.js",  naming: "../../ctx_plugin/dist/hooks/tool-naming.js" },
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
// Security patterns for permission.ask hook
// These are independent from the routing-level patterns in hooks/routing.ts
// (shorter list focused on auto-grant/deny, not structural safety analysis)
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

function isSafeCommand(cmd: string): boolean {
  return SAFE_PATTERNS.some(rx => rx.test(cmd.trim()))
}

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(rx => rx.test(cmd))
}

// ─────────────────────────────────────────────────────────
// First-message injection tracking
// ─────────────────────────────────────────────────────────

const _firstMessageInjected = new Set<string>();

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
        // Dynamic import succeeded — use lazy-loaded routing hooks
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
        // Dynamic import failed — use static import (available when compiled via tsc)
        try {
          const normalized = normalizeToolName(tool)
          if (!isCtxPluginTool(normalized)) {
            const decision = routeTool({ tool, args, sessionId, projectDir: input.directory ?? input.worktree, mcpReady })

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
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("[ctx_plugin routing]")) throw err
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

    // Inject ROUTING_BLOCK on first message + guidance from routing decisions.
    // NOTE: inject into output.context instead of output.parts to avoid
    // polluting the message content that LLM processes.
    "chat.message": async (input, output) => {
      // First message of session: store routing block in context (not visible to LLM as message)
      if (!_firstMessageInjected.has(sessionId)) {
        _firstMessageInjected.add(sessionId);
        output.context = output.context ?? {}
        if (typeof output.context === "object" && output.context !== null) {
          ;(output.context as Record<string, unknown>).__routingBlock =
            ROUTING_BLOCK + "\n\n" +
            "Memory tip: Use summary_recall or ctx_session to check prior context before asking the user."
        }
      }

      // Guidance from routing decisions also goes into context
      if (output.context) {
        const ctx = output.context as Record<string, unknown>
        if (ctx.__ctxPluginGuidance) {
          output.context = output.context ?? {}
          if (typeof output.context === "object" && output.context !== null) {
            ;(output.context as Record<string, unknown>).__ctxPluginGuidance = ctx.__ctxPluginGuidance
          }
        }
      }
    },
  }
}

export default RoutingPlugin
