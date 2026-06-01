/**
 * Tool call classifier — extracts structured events from tool call data.
 * Pure functions, no side effects.
 */

export interface ToolCallInfo {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse?: string;
  isError?: boolean;
}

export interface ClassifiedEvent {
  type: string;
  category: string;
  priority: number;
  data: string;
  tool?: string;
}

function safeStr(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function priorityFor(category: string): number {
  switch (category) {
    case "file": case "rule": case "task": case "decision": return 1;
    case "error": case "git": return 2;
    case "env": case "cwd": case "mcp": case "role": case "skill": case "subagent": return 3;
    case "data": case "intent": return 4;
    default: return 3;
  }
}

function extractFile(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName.toLowerCase();
  let filePath = "";
  let action = "";

  switch (tool) {
    case "read": case "read_file":
      filePath = safeStr(call.toolInput.filePath || call.toolInput.file_path || call.toolInput.path);
      action = "file_read";
      break;
    case "write": case "write_file": case "edit_file": case "multi_edit":
      filePath = safeStr(call.toolInput.filePath || call.toolInput.file_path || call.toolInput.path);
      action = "file_write";
      break;
    case "glob": case "search_files":
      filePath = safeStr(call.toolInput.pattern);
      action = "file_read";
      break;
    case "grep": case "search_content":
      filePath = safeStr(call.toolInput.pattern);
      action = "file_read";
      break;
  }

  if (!filePath) return [];

  const events: ClassifiedEvent[] = [{
    type: action,
    category: "file",
    priority: priorityFor("file"),
    data: filePath,
    tool: call.toolName,
  }];

  if (/CLAUDE\.md|AGENTS\.md|GEMINI\.md|rules?[\\/].*\.md$/i.test(filePath)) {
    events.push({
      type: "rule_load",
      category: "rule",
      priority: priorityFor("rule"),
      data: filePath,
      tool: call.toolName,
    });
  }

  return events;
}

function extractGit(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["bash", "run_command", "execute_command", "shell"].includes(tool)) return [];
  const cmd = safeStr(call.toolInput.command || call.toolInput.code);
  if (!/^git\s/.test(cmd.trim())) return [];
  return [{
    type: "git",
    category: "git",
    priority: priorityFor("git"),
    data: cmd.trim(),
    tool: call.toolName,
  }];
}

function extractError(call: ToolCallInfo): ClassifiedEvent[] {
  if (!call.isError) return [];
  return [{
    type: "tool_error",
    category: "error",
    priority: priorityFor("error"),
    data: `${call.toolName}: ${(call.toolResponse ?? "").slice(0, 200)}`,
    tool: call.toolName,
  }];
}

function extractMcp(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName;
  if (!tool.startsWith("mcp__") && !tool.startsWith("ctx_")) return [];
  return [{
    type: "mcp_tool_call",
    category: "mcp",
    priority: priorityFor("mcp"),
    data: JSON.stringify({ tool_name: tool, params: Object.keys(call.toolInput).length }),
    tool: call.toolName,
  }];
}

function extractTask(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["todo_write", "task"].includes(tool)) return [];
  const content = safeStr(call.toolInput.content || call.toolInput.todos || call.toolInput.name);
  if (!content) return [];
  return [{
    type: "task_update",
    category: "task",
    priority: priorityFor("task"),
    data: content.slice(0, 500),
    tool: call.toolName,
  }];
}

function extractCwd(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["bash", "run_command", "shell"].includes(tool)) return [];
  const cmd = safeStr(call.toolInput.command || call.toolInput.code);
  const cdMatch = cmd.trim().match(/^cd\s+(.+)/);
  if (!cdMatch) return [];
  return [{
    type: "cwd_change",
    category: "cwd",
    priority: priorityFor("cwd"),
    data: cdMatch[1].trim(),
    tool: call.toolName,
  }];
}

function extractSkill(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["run_skill", "use_skill"].includes(tool)) return [];
  const name = safeStr(call.toolInput.name || call.toolInput.skill);
  if (!name) return [];
  return [{
    type: "skill_invoke",
    category: "skill",
    priority: priorityFor("skill"),
    data: name,
    tool: call.toolName,
  }];
}

function extractSubagent(call: ToolCallInfo): ClassifiedEvent[] {
  const tool = call.toolName.toLowerCase();
  if (!["task", "dispatch_agent", "run_agent"].includes(tool)) return [];
  const name = safeStr(call.toolInput.subagent_name || call.toolInput.agent || call.toolInput.name);
  if (!name) return [];
  return [{
    type: "subagent_launched",
    category: "subagent",
    priority: priorityFor("subagent"),
    data: name,
    tool: call.toolName,
  }];
}

/**
 * Classify a tool call into zero or more structured session events.
 */
export function extractToolCall(
  sessionId: string,
  call: ToolCallInfo,
  projectDir?: string,
): Array<{
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  tool?: string;
  project_dir?: string;
  source_hook?: string;
}> {
  const extractors = [extractFile, extractGit, extractError, extractTask, extractCwd, extractMcp, extractSkill, extractSubagent];
  const events: Array<{
    session_id: string;
    type: string;
    category: string;
    priority: number;
    data: string;
    tool?: string;
    project_dir?: string;
    source_hook?: string;
  }> = [];

  for (const extract of extractors) {
    for (const ev of extract(call)) {
      events.push({
        ...ev,
        session_id: sessionId,
        project_dir: projectDir ?? "",
        source_hook: "mcp_context_forge",
      });
    }
  }

  if (events.length === 0) {
    events.push({
      session_id: sessionId,
      type: call.isError ? "tool_error" : "tool_call",
      category: call.isError ? "error" : "mcp",
      priority: call.isError ? 2 : 4,
      data: `${call.toolName}: ${safeStr(call.toolResponse).slice(0, 200)}`,
      tool: call.toolName,
      project_dir: projectDir ?? "",
      source_hook: "mcp_context_forge",
    });
  }

  return events;
}
