/**
 * tool-naming.ts — Normalize tool names across platforms
 *
 * opencode may use different casing/formatting for tool names.
 * This module normalizes them to a canonical form.
 */
const TOOL_ALIASES = {
    // Bash variants
    "bash": "Bash",
    "Bash": "Bash",
    "shell": "Bash",
    "Shell": "Bash",
    // Read variants
    "read": "Read",
    "Read": "Read",
    "read_file": "Read",
    // Grep variants
    "grep": "Grep",
    "Grep": "Grep",
    "GrepRequest": "Grep",
    // WebFetch variants
    "webfetch": "WebFetch",
    "WebFetch": "WebFetch",
    "mcp_web_fetch": "WebFetch",
    "mcp_fetch_tool": "WebFetch",
    // Agent variants
    "agent": "Agent",
    "Agent": "Agent",
    "Task": "Agent",
    "task": "Agent",
    // ctx_plugin MCP tool normalization
    "mcp__ctx_plugin__ctx_execute": "ctx_execute",
    "MCP:ctx_execute": "ctx_execute",
    "mcp__ctx_plugin__ctx_execute_file": "ctx_execute_file",
    "MCP:ctx_execute_file": "ctx_execute_file",
    "mcp__ctx_plugin__ctx_batch_execute": "ctx_batch_execute",
    "MCP:ctx_batch_execute": "ctx_batch_execute",
    "mcp__ctx_plugin__ctx_index": "ctx_index",
    "MCP:ctx_index": "ctx_index",
    "mcp__ctx_plugin__ctx_search": "ctx_search",
    "MCP:ctx_search": "ctx_search",
    "mcp__ctx_plugin__ctx_stats": "ctx_stats",
    "MCP:ctx_stats": "ctx_stats",
    "mcp__ctx_plugin__ctx_runtimes": "ctx_runtimes",
    "MCP:ctx_runtimes": "ctx_runtimes",
    "mcp__ctx_plugin__ctx_ping": "ctx_ping",
    "MCP:ctx_ping": "ctx_ping",
};
/**
 * Normalize a tool name to canonical form.
 * Returns the canonical name or the original if not found.
 */
export function normalizeToolName(name) {
    return TOOL_ALIASES[name] ?? name;
}
/**
 * Check if a tool name is an external MCP tool (not ctx_plugin).
 */
export function isExternalMcpTool(name) {
    if (name.startsWith("mcp__") && !name.includes("ctx_plugin"))
        return true;
    if (name.startsWith("MCP:") && !name.startsWith("MCP:ctx_"))
        return true;
    if (/^@\w+\//.test(name))
        return true;
    return false;
}
/**
 * Check if a tool name is a ctx_plugin MCP tool.
 */
export function isCtxPluginTool(name) {
    return (name.startsWith("ctx_") ||
        name.startsWith("mcp__ctx_plugin__") ||
        name.startsWith("MCP:ctx_"));
}
/**
 * Create a human-readable tool name for display.
 */
export function toolDisplayName(name) {
    const normalized = normalizeToolName(name);
    if (normalized.startsWith("ctx_")) {
        return normalized.replace(/_/g, " ");
    }
    return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}
