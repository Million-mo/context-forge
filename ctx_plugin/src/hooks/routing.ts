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

// Inline HTTP patterns — detect code-level HTTP in Bash (not curl/wget).
// These are stripped of heredoc content to avoid false positives
// from cat <<EOF blocks containing example code.
const INLINE_HTTP_PATTERNS: RegExp[] = [
  /\bfetch\s*\(\s*['"](https?:\/\/|http)/i,
  /\brequests\.(get|post|put|delete|patch)\s*\(/i,
  /\bhttp\.(get|request)\s*\(/i,
  /\burllib/i,
  /Net::HTTP/i,
  /\bLWP::/i,
];

// Build tools that produce extremely verbose output — hard-intercept to sandbox.
// Excludes npm/cargo/go which are handled by soft guidance.
const VERBOSE_BUILD_PATTERNS: RegExp[] = [
  /(^|\s|&&|\||;)(\.\/gradlew|gradlew|gradle|\.\/mvnw|mvnw|mvn|\.\/sbt|sbt)(\s|$)/i,
];

function stripHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "");
}

function hasInlineHttp(command: string): boolean {
  const noHeredoc = stripHeredocs(command);
  return INLINE_HTTP_PATTERNS.some(rx => rx.test(noHeredoc));
}

function isVerboseBuildTool(command: string): boolean {
  return VERBOSE_BUILD_PATTERNS.some(rx => rx.test(command));
}

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
      // ctx_execute / ctx_execute_file / ctx_batch_execute — security validation
      if (tool === "ctx_execute" || tool === "ctx_execute_file" || tool === "ctx_batch_execute") {
        return routeContextForgeTool(tool, args);
      }

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
    return {
      action: "deny",
      reason: "curl/wget piped to shell blocked by security policy. Use ctx_execute with fetch() instead.",
    };
  }

  // 3. Inline HTTP detection — code-level HTTP should use ctx_execute
  if (hasInlineHttp(command)) {
    if (!mcpReady) return { action: "allow" };
    return {
      action: "modify",
      reason: "Inline HTTP blocked. Use ctx_execute to write code that fetches and prints only the result.",
      updatedArgs: {
        command: `echo "context-mode: Inline HTTP blocked. Use ctx_execute(language, code) to fetch, process, and console.log() only the result. Do NOT retry with Bash."`,
      },
    };
  }

  // 4. Structurally bounded commands pass through (no guidance)
  if (isStructurallyBounded(command)) {
    return { action: "allow" };
  }

  // 5. Verbose build tools — hard-intercept, redirect to sandbox
  if (isVerboseBuildTool(command)) {
    if (!mcpReady) return { action: "allow" };
    const safeCmd = command
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
    return {
      action: "modify",
      reason: "Build tool output redirected to sandbox to protect context window.",
      updatedArgs: {
        command: `echo "Build tool redirected. Use ctx_execute(language: \\"shell\\", code: \\"${safeCmd} 2>&1 | tail -30\\") to run and print only errors/summary. Do NOT retry with Bash."`,
      },
    };
  }

  // 6. Build tool detected (npm/cargo/go — soft guidance)
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

  // 7. Unbounded output (install, run scripts)
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

  // 8. General bash guidance (once per session)
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
  if (!mcpReady) return { action: "allow" };

  return {
    action: "deny",
    reason: "WebFetch blocked. Use ctx_fetch_and_index(url, source) to fetch and index, then ctx_search to query. Or use ctx_execute to fetch and console.log() only what you need.",
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
  // Inject routing block into subagent prompts
  const subagentType = (args.subagent_type as string) ?? "";
  const fieldName = ["prompt", "request", "objective", "question", "query", "task"].find(
    (f) => f in args,
  );
  if (!fieldName) return { action: "allow" };

  const prompt = (args[fieldName] as string) ?? "";

  return {
    action: "modify",
    updatedArgs: {
      ...args,
      [fieldName]: prompt + "\n\n" + ROUTING_BLOCK_SUBAGENT,
      ...(subagentType === "Bash" ? { subagent_type: "general-purpose" } : {}),
    },
  };
}

/**
 * Security validation for ctx_execute / ctx_execute_file / ctx_batch_execute.
 * Checks shell code and file paths against deny patterns.
 */
function routeContextForgeTool(
  tool: string,
  args: Record<string, unknown>,
): RouteDecision {
  // ctx_execute: check shell code against Bash security policy
  if (tool === "ctx_execute" || tool === "ctx_execute_file") {
    const language = (args.language as string) ?? "";
    const code = (args.code as string) ?? "";

    if (language === "shell" && code) {
      if (hasDangerousPattern(code)) {
        return {
          action: "deny",
          reason: "Shell code blocked: matches dangerous pattern (curl|sh, eval, etc.)",
        };
      }
      if (hasInlineHttp(code)) {
        return {
          action: "deny",
          reason: "Inline HTTP in shell code blocked. Use ctx_execute with JS/TS fetch() instead.",
        };
      }
    }

    // ctx_execute_file: also check file path
    if (tool === "ctx_execute_file") {
      const filePath = (args.path as string) ?? "";
      if (filePath) {
        const security = checkSecurityPolicy({ tool: "Read", command: filePath });
        if (security.action === "deny") {
          return { action: "deny", reason: security.reason };
        }
      }
    }
  }

  // ctx_batch_execute: check each command individually
  if (tool === "ctx_batch_execute") {
    const raw = args.commands;
    const commands = Array.isArray(raw) ? raw as Array<{ command?: string }> : [];
    for (const entry of commands) {
      const cmd = entry.command ?? "";
      if (hasDangerousPattern(cmd)) {
        return {
          action: "deny",
          reason: `Batch command blocked: matches dangerous pattern`,
        };
      }
      if (hasInlineHttp(cmd)) {
        return {
          action: "deny",
          reason: "Inline HTTP in batch command blocked. Use ctx_execute with JS/TS fetch() instead.",
        };
      }
    }
  }

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
 * Full version — includes ctx_commands section for slash commands.
 */
export const ROUTING_BLOCK = createRoutingBlock(true);

/**
 * Routing block for subagents — omits ctx_commands (subagents can't use them).
 */
export const ROUTING_BLOCK_SUBAGENT = createRoutingBlock(false);

function createRoutingBlock(includeCommands: boolean): string {
  return `
<context_window_protection>
  <priority_instructions>
    Raw tool output floods context window. MUST use Context Forge MCP tools. Keep raw data in sandbox.
  </priority_instructions>

  <tool_selection_hierarchy>
    0. MEMORY: summary_recall | summary_search | ctx_session
       - On session start or after /clear, check prior context before asking user.
    1. GATHER: ctx_batch_execute(commands, queries)
       - Primary research tool. Runs commands, auto-indexes, searches. ONE call replaces many steps.
       - Each command: {label: "section header", command: "shell command"}
       - label becomes FTS5 chunk title — descriptive labels improve search.
    2. FOLLOW-UP: ctx_search(queries: ["q1", "q2", ...])
       - All follow-up questions. ONE call, many queries.
    3. PROCESSING: ctx_execute(language, code) | ctx_execute_file(path, language, code)
       - API calls, log analysis, data processing.
  </tool_selection_hierarchy>

  <forbidden_actions>
    - NO Bash for commands producing >20 lines output.
    - NO Read for analysis — use ctx_execute_file. Read IS correct for files you intend to Edit.
    - NO WebFetch — use ctx_fetch_and_index.
    - Bash ONLY for git/mkdir/rm/mv/navigation.
    - NO ctx_execute or ctx_execute_file for file creation/modification.
      ctx_execute is for analysis, processing, computation only.
  </forbidden_actions>

  <file_writing_policy>
    ALWAYS use native Write/Edit tools for file creation/modification.
    NEVER use ctx_execute, ctx_execute_file, or Bash to write files.
    Applies to all file types: code, configs, plans, specs, YAML, JSON, markdown.
  </file_writing_policy>

  <output_constraints>
    <communication_style>
      Terse like caveman. Technical substance exact. Only fluff die.
      Use fragments when clear. Short synonyms (fix not "implement a solution for").
      Technical terms exact. Code blocks unchanged.
      Auto-expand for: security warnings, irreversible actions, user confusion.
    </communication_style>
    <artifact_policy>
      Write artifacts (code, configs, PRDs) to FILES. NEVER inline.
      Return only: file path + 1-line description.
    </artifact_policy>
    <response_format>
      Concise summary:
      - Actions taken (2-3 bullets)
      - File paths created/modified
      - Key findings
    </response_format>
  </output_constraints>

  <session_continuity>
    Skills, roles, and decisions set during this session remain active until the user revokes them.
    Do not drop behavioral directives as context grows.
  </session_continuity>
${includeCommands ? `
  <ctx_commands>
    "ctx stats" | "ctx-stats" | "/ctx-stats" | context savings question
    → Call ctx_stats tool, display full output verbatim.

    "ctx doctor" | "ctx-doctor" | "/ctx-doctor" | diagnose context-mode
    → Call ctx_doctor tool, display as checklist.

    "ctx purge" | "ctx-purge" | "/ctx-purge" | wipe/reset knowledge base
    → Call ctx_purge tool. Warn: irreversible.

    After /clear or /compact: knowledge base preserved. Tell user: "Context Forge knowledge base preserved."
  </ctx_commands>
` : ""}
</context_window_protection>`;
}
