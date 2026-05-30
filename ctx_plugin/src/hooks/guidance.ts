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

// ─────────────────────────────────────────────────────────
// Guidance Definitions
// ─────────────────────────────────────────────────────────

export type GuidanceType =
  | "bash"
  | "read"
  | "grep"
  | "external-mcp"
  | "build-tool"
  | "large-output";

export const GUIDANCE_MESSAGES: Record<GuidanceType, string> = {
  bash: (
    "<context_guidance>\n"
    + "  <tip>\n"
    + "    May produce large output. Use ctx_batch_execute(commands, queries) for multiple commands, "
    + "ctx_execute(language: \"shell\", code: \"...\") for single. "
    + "Only printed summary enters context. Bash only for: git, mkdir, rm, mv, navigation.\n"
    + "  </tip>\n"
    + "</context_guidance>"
  ),
  read: (
    "<context_guidance>\n"
    + "  <tip>\n"
    + "    Reading to Edit? Read is correct — Edit needs content in context.\n"
    + "    Reading to analyze/explore? Use ctx_execute_file(path, language, code) — "
    + "only printed summary enters context.\n"
    + "  </tip>\n"
    + "</context_guidance>"
  ),
  grep: (
    "<context_guidance>\n"
    + "  <tip>\n"
    + "    May flood context. Use ctx_execute(language: \"shell\", code: \"...\") "
    + "to run searches in sandbox. Only printed summary enters context.\n"
    + "  </tip>\n"
    + "</context_guidance>"
  ),
  "external-mcp": (
    "ctx_plugin guidance: External MCP tools can flood context. "
    + "Consider ctx_execute for structured tasks, or ctx_index for searchable content."
  ),
  "build-tool": (
    "ctx_plugin guidance: Build tools detected. "
    + "Consider ctx_execute for isolated builds with timeout control."
  ),
  "large-output": (
    "ctx_plugin guidance: Large command output detected. "
    + "ctx_execute truncates at 100MB. "
    + "Consider ctx_batch_execute with filtered output."
  ),
};

// ─────────────────────────────────────────────────────────
// Session Identity
// ─────────────────────────────────────────────────────────

function defaultSessionId(): string {
  return String(process.ppid);
}

function guidanceDir(sessionId: string): string {
  const id = sessionId ? `s-${sessionId}` : defaultSessionId();
  return resolve(tmpdir(), `ctx-plugin-guidance-${id}`);
}

// ─────────────────────────────────────────────────────────
// Guidance Throttle
// ─────────────────────────────────────────────────────────

const _shownInProcess = new Set<GuidanceType>();

/**
 * Show a guidance message exactly once per session.
 * Returns the message content if this is the first time for this session,
 * or null if it has already been shown.
 */
export function showGuidanceOnce(
  type: GuidanceType,
  sessionId?: string,
): string | null {
  // Fast path: same-process dedup
  if (_shownInProcess.has(type)) return null;

  const dir = guidanceDir(sessionId ?? "");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    _shownInProcess.add(type);
    return null;
  }

  const marker = resolve(dir, type);
  try {
    // O_CREAT | O_EXCL | O_WRONLY | O_TRUNC for atomic create-or-fail
    const fd = openSync(
      marker,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    closeSync(fd);
  } catch {
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
export function isGuidanceShown(type: GuidanceType, sessionId?: string): boolean {
  if (_shownInProcess.has(type)) return true;

  const marker = resolve(guidanceDir(sessionId ?? ""), type);
  try {
    const fd = openSync(marker, constants.O_RDONLY);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset all in-process guidance state.
 * Useful for testing.
 */
export function resetGuidanceState(): void {
  _shownInProcess.clear();
}

/**
 * Build an additionalContext string for injection into the prompt.
 */
export function buildGuidanceContext(
  type: GuidanceType,
  sessionId?: string,
): string | null {
  const message = showGuidanceOnce(type, sessionId);
  if (!message) return null;
  return `[ctx_plugin security guidance]: ${message}`;
}
