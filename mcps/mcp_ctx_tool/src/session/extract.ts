/**
 * Session event extraction — pure functions, zero side effects.
 *
 * Classifies Context Forge tool calls into structured SessionEvent objects
 * with category + priority. Adapted from context-mode's extract.ts.
 *
 * Categories:
 *   file     — file reads/writes (priority 1)
 *   git      — git operations (priority 2)
 *   task     — task tracking (priority 1)
 *   error    — tool call errors (priority 2)
 *   decision — user decisions (priority 1, extracted from user messages)
 *   rule     — CLAUDE.md / project rules (priority 1)
 *   env      — environment setup (priority 3)
 *   cwd      — working directory changes (priority 3)
 *   mcp      — MCP tool usage (priority 3)
 *   data     — data references (priority 4)
 */

import type { SessionEvent, EventCategory } from "../session-db.js";

// ── Public interface ────────────────────────────────────────────────────────

export interface ToolCallInfo {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function safeStr(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function priorityFor(category: EventCategory): number {
  switch (category) {
    case "file": return 1;
    case "rule": return 1;
    case "task": return 1;
    case "decision": return 1;
    case "error": return 2;
    case "git": return 2;
    case "env": return 3;
    case "cwd": return 3;
    case "role": return 3;
    case "skill": return 3;
    case "subagent": return 3;
    case "mcp": return 3;
    case "data": return 4;
    case "intent": return 4;
    default: return 3;
  }
}

// ── Category extractors ─────────────────────────────────────────────────────

function extractFile(call: ToolCallInfo): SessionEvent[] {
  const events: SessionEvent[] = [];
  const tool = call.toolName.toLowerCase();

  let filePath = "";
  let action: string;

  switch (tool) {
    case "read":
    case "read_file":
      filePath = safeStr(call.toolInput.filePath || call.toolInput.file_path || call.toolInput.path);
      action = "file_read";
      break;
    case "write":
    case "write_file":
    case "edit_file":
    case "multi_edit":
      filePath = safeStr(call.toolInput.filePath || call.toolInput.file_path || call.toolInput.path);
      action = "file_write";
      break;
    case "glob":
    case "search_files":
      filePath = safeStr(call.toolInput.pattern);
      action = "file_read";
      break;
    case "grep":
    case "search_content":
      filePath = safeStr(call.toolInput.pattern);
      action = "file_read";
      break;
    default:
      return [];
  }

  if (!filePath) return [];

  // Detect rule files
  const isRule = /CLAUDE\.md|AGENTS\.md|GEMINI\.md|QWEN\.md|rules?[\\/].*\.md$/i.test(filePath);

  events.push({
    session_id: "",
    type: action,
    category: "file",
    priority: priorityFor("file"),
    data: filePath,
    tool: call.toolName,
  });

  if (isRule) {
    events.push({
      session_id: "",
      type: "rule_load",
      category: "rule",
      priority: priorityFor("rule"),
      data: filePath,
      tool: call.toolName,
    });
  }

  return events;
}

function extractGit(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["bash", "run_command", "execute_command", "shell"].includes(tool)) return [];

  const cmd = safeStr(call.toolInput.command || call.toolInput.code);
  const isGit = /^git\s/.test(cmd.trim());
  if (!isGit) return [];

  // Classify git subcommand
  let type = "git";
  if (/\bgit\s+status\b/.test(cmd)) type = "git_status";
  else if (/\bgit\s+diff\b/.test(cmd)) type = "git_diff";
  else if (/\bgit\s+commit\b/.test(cmd)) type = "git_commit";
  else if (/\bgit\s+(checkout|switch)\b/.test(cmd)) type = "git_branch";
  else if (/\bgit\s+(push|pull|fetch)\b/.test(cmd)) type = "git_remote";
  else if (/\bgit\s+log\b/.test(cmd)) type = "git_log";

  return [{
    session_id: "",
    type,
    category: "git",
    priority: priorityFor("git"),
    data: cmd.trim(),
    tool: call.toolName,
  }];
}

function extractError(call: ToolCallInfo): SessionEvent[] {
  if (!call.isError) return [];

  return [{
    session_id: "",
    type: "tool_error",
    category: "error",
    priority: priorityFor("error"),
    data: `${call.toolName}: ${(call.toolResponse ?? "").slice(0, 200)}`,
    tool: call.toolName,
  }];
}

function extractTask(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["todo_write", "task"].includes(tool)) return [];

  const content = safeStr(call.toolInput.content || call.toolInput.todos || call.toolInput.name);
  if (!content) return [];

  return [{
    session_id: "",
    type: "task_update",
    category: "task",
    priority: priorityFor("task"),
    data: content.slice(0, 500),
    tool: call.toolName,
  }];
}

function extractCwd(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName.toLowerCase();
  if (tool !== "bash" && tool !== "run_command" && tool !== "shell") return [];

  const cmd = safeStr(call.toolInput.command || call.toolInput.code);
  const cdMatch = cmd.trim().match(/^cd\s+(.+)/);
  if (!cdMatch) return [];

  return [{
    session_id: "",
    type: "cwd_change",
    category: "cwd",
    priority: priorityFor("cwd"),
    data: cdMatch[1].trim(),
    tool: call.toolName,
  }];
}

function extractEnv(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["bash", "run_command", "shell"].includes(tool)) return [];

  const cmd = safeStr(call.toolInput.command || call.toolInput.code);
  const hasEnv = /^(export|set)\s+\w+=/.test(cmd.trim()) || /\b(npm|pip|brew|apt|yum|dnf|pnpm|yarn)\s+(install|i)\b/.test(cmd);
  if (!hasEnv) return [];

  return [{
    session_id: "",
    type: "env_setup",
    category: "env",
    priority: priorityFor("env"),
    data: cmd.trim().slice(0, 200),
    tool: call.toolName,
  }];
}

function extractMcp(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName;

  // Detect MCP tools (prefixed with mcp__ or ctx_)
  if (!tool.startsWith("mcp__") && !tool.startsWith("ctx_")) return [];

  return [{
    session_id: "",
    type: "mcp_tool_call",
    category: "mcp",
    priority: priorityFor("mcp"),
    data: JSON.stringify({ tool_name: tool, params: Object.keys(call.toolInput).length }),
    tool: call.toolName,
  }];
}

function extractSkill(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName.toLowerCase();
  if (tool !== "run_skill" && tool !== "use_skill") return [];

  const skillName = safeStr(call.toolInput.name || call.toolInput.skill);
  if (!skillName) return [];

  return [{
    session_id: "",
    type: "skill_invoke",
    category: "skill",
    priority: priorityFor("skill"),
    data: skillName,
    tool: call.toolName,
  }];
}

function extractSubagent(call: ToolCallInfo): SessionEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["task", "dispatch_agent", "run_agent"].includes(tool)) return [];

  const subagentName = safeStr(call.toolInput.subagent_name || call.toolInput.agent || call.toolInput.name);
  if (!subagentName) return [];

  return [{
    session_id: "",
    type: "subagent_launched",
    category: "subagent",
    priority: priorityFor("subagent"),
    data: subagentName,
    tool: call.toolName,
  }];
}

// ── Main classifier ─────────────────────────────────────────────────────────

/**
 * Classify a tool call into zero or more structured SessionEvent objects.
 * Pure function — no side effects, no DB access.
 */
export function extractToolCall(
  sessionId: string,
  call: ToolCallInfo,
  projectDir?: string,
): SessionEvent[] {
  const extractors = [
    extractFile,
    extractGit,
    extractError,
    extractTask,
    extractCwd,
    extractEnv,
    extractMcp,
    extractSkill,
    extractSubagent,
  ];

  const events: SessionEvent[] = [];

  for (const extract of extractors) {
    const result = extract(call);
    for (const ev of result) {
      events.push({
        ...ev,
        session_id: sessionId,
        project_dir: projectDir ?? "",
        source_hook: "mcp_ctx_tool",
      });
    }
  }

  // If no classifier matched, emit a generic event
  if (events.length === 0) {
    events.push({
      session_id: sessionId,
      type: call.isError ? "tool_error" : "tool_call",
      category: call.isError ? "error" : "mcp",
      priority: call.isError ? 2 : 4,
      data: `${call.toolName}: ${safeStr(call.toolResponse).slice(0, 200)}`,
      tool: call.toolName,
      project_dir: projectDir ?? "",
      source_hook: "mcp_ctx_tool",
    });
  }

  return events;
}

/**
 * Parse user messages for decision events.
 * Scans for explicit decision markers like "let's use X", "we'll go with Y".
 */
export function extractDecisions(
  sessionId: string,
  userMessage: string,
  projectDir?: string,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const patterns = [
    /\b(let'?s|we('ll| will)|I('ll| will)|going to)\s+(use|go with|do|try|implement|switch to|adopt|change to|refactor to)\s+(.+?)(?:\.|$)/gi,
    /\b(decision|decided):\s*(.+?)(?:\.|$)/gi,
    /\b(choose|chose|picked|selected)\s+(.+?)(?:\.|$)/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(userMessage)) !== null) {
      const decision = match[0].trim();
      if (decision.length > 5 && decision.length < 200) {
        events.push({
          session_id: sessionId,
          type: "decision",
          category: "decision",
          priority: priorityFor("decision"),
          data: decision,
          project_dir: projectDir ?? "",
          source_hook: "mcp_ctx_tool",
        });
      }
    }
  }

  return events;
}
