/**
 * routing.ts — Tool routing logic for ctx_plugin
 *
 * Ported from context-mode's hooks/core/routing.mjs, simplified for opencode.
 * Handles:
 *   - Safe command detection (structurally bounded, no injection risk)
 *   - Security policy enforcement
 *   - Guidance throttle injection
 *   - Tool-specific routing decisions
 */

import { checkSecurityPolicy } from "../security.js";
import { normalizeToolName, isCtxPluginTool, isExternalMcpTool } from "./tool-naming.js";
import { buildGuidanceContext } from "./guidance.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface RouteDecision {
  action: "allow" | "deny" | "modify" | "context" | "ask";
  reason?: string;
  updatedArgs?: Record<string, unknown>;
  additionalContext?: string;
  bytesAvoided?: number;
}

export interface RouteContext {
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
  projectDir?: string;
  mcpReady?: boolean;
}

// ─────────────────────────────────────────────────────────
// Safe Command Patterns
// ─────────────────────────────────────────────────────────

/**
 * Commands that are structurally bounded — their output cannot grow
 * unboundedly, so they are safe to run without guidance.
 */
const SAFE_COMMAND_PATTERNS: RegExp[] = [
  // System probes
  /^pwd$/,
  /^whoami$/,
  /^hostname(?:\s+-[a-zA-Z]+)?$/,
  /^uname(?:\s+-[a-zA-Z]+)?$/,
  /^id(?:\s+\S+)?$/,
  /^date(?:\s+[^\r\n]+)?$/,
  /^echo\s.*$/,
  /^printf\s.*$/,
  // Command resolution
  /^which\s+\S+(?:\s+\S+)*$/,
  /^type\s+\S+(?:\s+\S+)*$/,
  /^command\s+-v\s+\S+(?:\s+\S+)*$/,
  // Path utilities
  /^readlink(?:\s+[^\r\n]+)?$/,
  /^basename(?:\s+[^\r\n]+)?$/,
  /^dirname(?:\s+[^\r\n]+)?$/,
  /^realpath(?:\s+[^\r\n]+)?$/,
  // Navigation
  /^cd(?:\s+[^\r\n]+)?$/,
  /^mkdir\s[^\r\n]+$/,
  /^touch\s[^\r\n]+$/,
  // Safe fs ops (no recursive delete, no verbose flags)
  /^mv\s[^\r\n]+$/,
  /^cp\s[^\r\n]+$/,
  /^ln\s[^\r\n]+$/,
  /^ls(?!\s+-[a-zA-Z]*R)(?:\s+[^\r\n]+)?$/,
  /^cat\s[^\r\n]+$/,
  /^head\s[^\r\n]+$/,
  /^tail\s[^\r\n]+$/,
  /^wc\s[^\r\n]+$/,
  /^stat\s[^\r\n]+$/,
  /^file\s[^\r\n]+$/,
  // Git read-only
  /^git\s+status(?:\s+[^\r\n]+)?$/,
  /^git\s+rev-parse(?:\s+[^\r\n]+)?$/,
  /^git\s+remote(?:\s+-v|\s+show\s+\S+)?$/,
  /^git\s+branch(?:\s+[^\r\n]+)?$/,
  /^git\s+config\s+--get(?:\s+[^\r\n]+)?$/,
  /^git\s+diff\s+--stat(?:\s+[^\r\n]+)?$/,
  /^git\s+diff\s+--name-only(?:\s+[^\r\n]+)?$/,
  /^git\s+diff(?:\s+[^\r\n]+)?$/,
  /^git\s+stash\s+list$/,
  /^git\s+tag(?:\s+-l(?:\s+[^\r\n]+)?)?$/,
  /^git\s+log\s+-\d{1,3}(?:\s+[^\r\n]+)?$/,
  /^git\s+show(?:\s+[^\r\n]+)?$/,
  /^git\s+ls-files(?:\s+[^\r\n]+)?$/,
  /^git\s+ls-tree(?:\s+[^\r\n]+)?$/,
  /^git\s+cat-file(?:\s+[^\r\n]+)?$/,
  /^git\s+diff-index(?:\s+[^\r\n]+)?$/,
  /^git\s+hash-object(?:\s+[^\r\n]+)?$/,
  /^git\s+ls-remote(?:\s+[^\r\n]+)?$/,
  /^git\s+describe(?:\s+[^\r\n]+)?$/,
  /^git\s+name-rev(?:\s+[^\r\n]+)?$/,
  /^git\s+for-each-ref(?:\s+[^\r\n]+)?$/,
  /^git\s+archive(?:\s+[^\r\n]+)?$/,
  /^git\s+verify-commit(?:\s+[^\r\n]+)?$/,
  /^git\s+verify-tag(?:\s+[^\r\n]+)?$/,
  // Version flags (not running code)
  /(?:^|\s)--version(?:\s|$)/,
  /^\S+\s+-V(?:\s|$)/,
  // Npm scripts (read-only introspection)
  /^npm\s+run\s+\w+\s+--\s*--dry-run(?:\s|$)/,
  /^npm\s+ls(?:\s+[^\r\n]+)?$/,
  /^npm\s+info(?:\s+[^\r\n]+)?$/,
  /^npm\s+view(?:\s+[^\r\n]+)?$/,
  /^npm\s+search(?:\s+[^\r\n]+)?$/,
  /^npm\s+ outdated(?:\s+[^\r\n]+)?$/,
  /^pnpm\s+list(?:\s+[^\r\n]+)?$/,
  /^pnpm\s+info(?:\s+[^\r\n]+)?$/,
  /^yarn\s+info(?:\s+[^\r\n]+)?$/,
  /^yarn\s+list(?:\s+[^\r\n]+)?$/,
  /^bunpm\s+info(?:\s+[^\r\n]+)?$/,
];

// Commands that could have unbounded output
const UNBOUNDED_PATTERNS: RegExp[] = [
  /^npm\s+install(?:\s+|$)/,
  /^pnpm\s+install(?:\s+|$)/,
  /^yarn\s+add(?:\s+|$)/,
  /^npm\s+run(?:\s+[^\r\n]+)?$/,
  /^pnpm\s+run(?:\s+[^\r\n]+)?$/,
  /^bun\s+run(?:\s+[^\r\n]+)?$/,
  /^cargo\s+build(?:\s+|$)/,
  /^cargo\s+test(?:\s+|$)/,
  /^go\s+run(?:\s+|$)/,
  /^python\s+.*\.py(?:\s+|$)/,
];

// Build tools
const BUILD_TOOL_PATTERNS: RegExp[] = [
  /^npm\s+run\s+(?!.*--help)/,
  /^pnpm\s+run\s+(?!.*--help)/,
  /^yarn\s+run\s+(?!.*--help)/,
  /^bun\s+run\s+(?!.*--help)/,
  /^cargo\s+(?!env|which|version|help)/,
  /^go\s+build(?:\s+|$)/,
  /^go\s+test(?:\s+|$)/,
  /^gradle\s+/,
  /^make(?:\s+|$)/,
  /^cmake\s+/,
  /^makefile(?:\s+|$)/,
  /^pnpm\s+build(?:\s+|$)/,
  /^yarn\s+build(?:\s+|$)/,
  /^npm\s+run\s+build(?:\s+|$)/,
];

// Dangerous patterns that warrant blocking
const DANGEROUS_PATTERNS: RegExp[] = [
  /curl.*\|.*sh/i,
  /wget.*\|.*sh/i,
  /\$\([^)]*\).*\|.*sh/i,
  /`[^`]*`.*\|.*sh/i,
];

// ─────────────────────────────────────────────────────────
// Shell Evaluation Detection
// ─────────────────────────────────────────────────────────

const SHELL_CONTROL_OPERATORS = /[|`\n\r]|\$\(|>>|>|<(?!<)|&(?!&)|&&|\|\||;/;

function isStructurallyBounded(command: string): boolean {
  if (!command) return false;
  const trimmed = command.trim();
  if (SHELL_CONTROL_OPERATORS.test(trimmed)) return false;
  return SAFE_COMMAND_PATTERNS.some(rx => rx.test(trimmed));
}

function hasDangerousPattern(command: string): boolean {
  return DANGEROUS_PATTERNS.some(rx => rx.test(command));
}

function isBuildTool(command: string): boolean {
  return BUILD_TOOL_PATTERNS.some(rx => rx.test(command));
}

function isUnboundedOutput(command: string): boolean {
  return UNBOUNDED_PATTERNS.some(rx => rx.test(command));
}

// ─────────────────────────────────────────────────────────
// Command Extraction
// ─────────────────────────────────────────────────────────

function extractCommand(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.command === "object" && args.command !== null) {
    const cmd = args.command as Record<string, unknown>;
    if (typeof cmd.raw === "string") return cmd.raw;
    if (typeof cmd.value === "string") return cmd.value;
  }
  return "";
}

// ─────────────────────────────────────────────────────────
// Main Routing Function
// ─────────────────────────────────────────────────────────

/**
 * Route a tool call and return a decision.
 * This is the main entry point for tool.execute.before.
 */
export function routeTool(ctx: RouteContext): RouteDecision {
  const tool = normalizeToolName(ctx.tool);
  const args = ctx.args;
  const sessionId = ctx.sessionId;
  const command = extractCommand(args);

  // Route based on tool type
  switch (tool) {
    case "Bash":
      return routeBash(command, args, sessionId, ctx.mcpReady ?? false);

    case "Read":
      return routeRead(args, sessionId, ctx.mcpReady ?? false);

    case "Grep":
      return routeGrep(args, sessionId, ctx.mcpReady ?? false);

    case "WebFetch":
      return routeWebFetch(sessionId, ctx.mcpReady ?? false);

    case "Edit":
      return routeEdit(args, sessionId);

    case "Write":
      return routeWrite(args, sessionId);

    case "Agent":
      return routeAgent(args, sessionId);

    default:
      // Check for external MCP tools
      if (isExternalMcpTool(tool)) {
        return routeExternalMcp(sessionId);
      }

      // ctx_plugin tools pass through
      if (isCtxPluginTool(tool)) {
        return { action: "allow" };
      }

      // Unknown tools: allow by default
      return { action: "allow" };
  }
}

// ─────────────────────────────────────────────────────────
// Tool-Specific Routers
// ─────────────────────────────────────────────────────────

function routeBash(
  command: string,
  args: Record<string, unknown>,
  sessionId: string,
  mcpReady: boolean,
): RouteDecision {
  if (!command) return { action: "allow" };

  // 1. Security policy check (deny patterns)
  const security = checkSecurityPolicy({ tool: "Bash", command });
  if (security.action === "deny") {
    return {
      action: "deny",
      reason: security.reason,
    };
  }

  // 2. Dangerous command detection (curl piped to sh, etc.)
  if (hasDangerousPattern(command)) {
    const guidance = buildGuidanceContext("curl", sessionId);
    return {
      action: "context",
      reason: "Dangerous pattern detected",
      additionalContext: guidance ?? undefined,
    };
  }

  // 3. Structurally bounded commands pass through (no guidance)
  if (isStructurallyBounded(command)) {
    return { action: "allow" };
  }

  // 4. Build tool detected
  if (isBuildTool(command)) {
    if (mcpReady) {
      const guidance = buildGuidanceContext("build-tool", sessionId);
      if (guidance) {
        return {
          action: "context",
          additionalContext: guidance,
        };
      }
    }
    return { action: "allow" };
  }

  // 5. Unbounded output (install, run scripts)
  if (isUnboundedOutput(command)) {
    const guidance = buildGuidanceContext("large-output", sessionId);
    if (guidance) {
      return {
        action: "context",
        additionalContext: guidance,
      };
    }
    return { action: "allow" };
  }

  // 6. General bash guidance (once per session)
  if (mcpReady) {
    const guidance = buildGuidanceContext("bash", sessionId);
    if (guidance) {
      return {
        action: "context",
        additionalContext: guidance,
      };
    }
  }

  return { action: "allow" };
}

function routeRead(
  args: Record<string, unknown>,
  sessionId: string,
  mcpReady: boolean,
): RouteDecision {
  const path = args.path as string | undefined;
  if (!path) return { action: "allow" };

  // Large file guidance
  // Path-based size estimation is heuristic; actual size check would need fs.stat
  const largeFileIndicators = [
    /\.min\.(js|css)$/,
    /node_modules/,
    /\.log$/,
    /\.sqlite/,
    /dist\//,
    /build\//,
    /\.bundle\./,
    /\.wasm$/,
  ];

  const isLikelyLarge = largeFileIndicators.some(rx => rx.test(path));

  if (isLikelyLarge && mcpReady) {
    const guidance = buildGuidanceContext("read", sessionId);
    if (guidance) {
      return {
        action: "context",
        additionalContext: guidance,
      };
    }
  }

  return { action: "allow" };
}

function routeGrep(
  args: Record<string, unknown>,
  sessionId: string,
  mcpReady: boolean,
): RouteDecision {
  if (!mcpReady) return { action: "allow" };

  const guidance = buildGuidanceContext("grep", sessionId);
  if (guidance) {
    return {
      action: "context",
      additionalContext: guidance,
    };
  }

  return { action: "allow" };
}

function routeWebFetch(
  sessionId: string,
  mcpReady: boolean,
): RouteDecision {
  if (!mcpReady) {
    return { action: "allow" };
  }

  const guidance = buildGuidanceContext("webfetch", sessionId);

  return {
    action: "context",
    additionalContext: guidance ?? "WebFetch is discouraged in sandbox. Consider ctx_execute with fetch() or ctx_index for web content.",
  };
}

function routeEdit(
  args: Record<string, unknown>,
  sessionId: string,
): RouteDecision {
  // Edit operations are generally safe
  return { action: "allow" };
}

function routeWrite(
  args: Record<string, unknown>,
  sessionId: string,
): RouteDecision {
  // Write operations: check for dangerous paths
  const path = args.path as string | undefined;
  if (!path) return { action: "allow" };

  const dangerousPaths = [
    /^\/(?:etc|usr)\//,
    /system32/i,
    /\.ssh\//,
    /\.aws\//,
    /\.config\/(?:passwd|secret|key|cert)/i,
  ];

  if (dangerousPaths.some(rx => rx.test(path))) {
    return {
      action: "deny",
      reason: `Write to sensitive path blocked: ${path}`,
    };
  }

  return { action: "allow" };
}

function routeAgent(
  args: Record<string, unknown>,
  sessionId: string,
): RouteDecision {
  // Agent/subagent: inject routing block into prompt if available
  // For now, allow
  return { action: "allow" };
}

function routeExternalMcp(sessionId: string): RouteDecision {
  const guidance = buildGuidanceContext("external-mcp", sessionId);
  if (guidance) {
    return {
      action: "context",
      additionalContext: guidance,
    };
  }
  return { action: "allow" };
}

// ─────────────────────────────────────────────────────────
// Guidance Block (injected into Agent prompts)
// ─────────────────────────────────────────────────────────

/**
 * Routing block injected into Agent/subagent prompts.
 */
export const ROUTING_BLOCK = `
## ctx_plugin Routing Guidance

When the ctx_plugin MCP server is available, prefer these tools:
- ctx_execute: sandboxed code execution (any language, 100MB output limit)
- ctx_execute_file: execute scripts with file-based content
- ctx_batch_execute: sequential commands with aggregated output
- ctx_search: FTS5 full-text search across indexed content
- ctx_index: index files or content for search

Security rules:
- curl/wget piped to shell is blocked by security policy
- WebFetch is discouraged; use ctx_execute with fetch() instead
- Shell evaluation in non-shell code is scanned by security policy
`.trim();
