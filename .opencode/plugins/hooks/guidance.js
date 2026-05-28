/**
 * guidance.ts — Per-session one-shot guidance throttle
 *
 * Shows each advisory guidance type at most once per session.
 * Uses hybrid approach:
 *   - In-memory Set for same-process (opencode ts-plugin)
 *   - Atomic file creation with O_EXCL for cross-process dedup
 *
 * Session identity is resolved via process.ppid (stable host PID).
 */
import { mkdirSync, openSync, closeSync, constants } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
export const GUIDANCE_MESSAGES = {
    bash: ("ctx_plugin guidance: For multi-step bash, prefer ctx_execute for isolation. "
        + "Large outputs are auto-truncated at 100MB. "
        + "Use ctx_batch_execute for sequential commands."),
    read: ("ctx_plugin guidance: For large file analysis (>50KB), "
        + "ctx_execute_file provides sandboxed read with token estimation. "
        + "RTK can rewrite read paths."),
    grep: ("ctx_plugin guidance: For multi-file search, ctx_execute enables "
        + "sandboxed grep with parallel execution. "
        + "Consider ctx_search for FTS5 full-text search."),
    "external-mcp": ("ctx_plugin guidance: External MCP tools can flood context. "
        + "Consider ctx_execute for structured tasks, or ctx_index for searchable content."),
    curl: ("ctx_plugin guidance: curl/wget piped to shell is risky. "
        + "Use ctx_execute with fetch() for HTTP requests, "
        + "or ctx_fetch_and_index for web content."),
    webfetch: ("ctx_plugin guidance: WebFetch is discouraged in sandbox. "
        + "Use ctx_execute with fetch() or ctx_index for web content."),
    "build-tool": ("ctx_plugin guidance: Build tools detected. "
        + "Consider ctx_execute for isolated builds with timeout control."),
    "large-output": ("ctx_plugin guidance: Large command output detected. "
        + "ctx_execute truncates at 100MB. "
        + "Consider ctx_batch_execute with filtered output."),
};
// ─────────────────────────────────────────────────────────
// Session Identity
// ─────────────────────────────────────────────────────────
function defaultSessionId() {
    return String(process.ppid);
}
function guidanceDir(sessionId) {
    const id = sessionId ? `s-${sessionId}` : defaultSessionId();
    return resolve(tmpdir(), `ctx-plugin-guidance-${id}`);
}
// ─────────────────────────────────────────────────────────
// Guidance Throttle
// ─────────────────────────────────────────────────────────
const _shownInProcess = new Set();
/**
 * Show a guidance message exactly once per session.
 * Returns the message content if this is the first time for this session,
 * or null if it has already been shown.
 */
export function showGuidanceOnce(type, sessionId) {
    // Fast path: same-process dedup
    if (_shownInProcess.has(type))
        return null;
    const dir = guidanceDir(sessionId ?? "");
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch {
        _shownInProcess.add(type);
        return null;
    }
    const marker = resolve(dir, type);
    try {
        // O_CREAT | O_EXCL | O_WRONLY | O_TRUNC for atomic create-or-fail
        const fd = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        closeSync(fd);
    }
    catch {
        // EEXIST = already shown in another process
        _shownInProcess.add(type);
        return null;
    }
    _shownInProcess.add(type);
    return GUIDANCE_MESSAGES[type];
}
/**
 * Check if a guidance type has been shown for a session (without marking it).
 */
export function isGuidanceShown(type, sessionId) {
    if (_shownInProcess.has(type))
        return true;
    const marker = resolve(guidanceDir(sessionId ?? ""), type);
    try {
        const fd = openSync(marker, constants.O_RDONLY);
        closeSync(fd);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Reset all in-process guidance state.
 * Useful for testing.
 */
export function resetGuidanceState() {
    _shownInProcess.clear();
}
/**
 * Build an additionalContext string for injection into the prompt.
 */
export function buildGuidanceContext(type, sessionId) {
    const message = showGuidanceOnce(type, sessionId);
    if (!message)
        return null;
    return `[ctx_plugin security guidance]: ${message}`;
}
