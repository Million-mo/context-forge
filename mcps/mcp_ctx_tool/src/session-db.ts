/**
 * Session event store for mcp_ctx_tool.
 *
 * Stores tool call events, session metadata, and tool-call statistics.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { Database } from "./db-base.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export type EventType =
  | "tool_call"
  | "redirect"
  | "guidance"
  | "security_block"
  | "session_start"
  | "session_end";

export interface ToolEvent {
  id?: number;
  session_id: string;
  event_type: EventType;
  tool: string;
  args: string;
  result: string;
  bytes_avoided: number;
  bytes_returned: number;
  created_at?: string;
}

export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
}

export interface ToolCallStats {
  totalCalls: number;
  totalBytesReturned: number;
  byTool: Record<string, { calls: number; bytesReturned: number }>;
}

// ─────────────────────────────────────────────────────────
// Path Resolution
// ─────────────────────────────────────────────────────────

function getSessionsDir(): string {
  const base =
    process.env.CTX_PLUGIN_DATA_DIR ||
    (process.env.XDG_DATA_HOME
      ? resolve(process.env.XDG_DATA_HOME, "ctx_plugin")
      : process.platform === "win32"
        ? resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "ctx_plugin")
        : resolve(homedir(), ".local", "share", "ctx_plugin"));
  return resolve(base, "sessions");
}

function resolveSessionDbPath(projectDir?: string): string {
  const sessionsDir = getSessionsDir();
  const hashBase = projectDir || process.cwd();
  const hash = createHash("sha256")
    .update(hashBase.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return join(sessionsDir, `${hash}.db`);
}

// ─────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────

let _db: Database | null = null;
let _dbLazyPath: string | null = null;

function getDb(): Database {
  if (!_db) {
    _db = new Database(_dbLazyPath ?? resolveSessionDbPath());
  }
  return _db;
}

function getDbOrNull(): Database | null {
  return _db;
}

export function initSessionDb(projectDir?: string): void {
  if (!_db) {
    _dbLazyPath = resolveSessionDbPath(projectDir);
    _db = new Database(_dbLazyPath);
  }
}

export function closeSessionDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getSessionDbPath(): string {
  return _dbLazyPath ?? resolveSessionDbPath();
}

// ─────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────

const MAX_EVENTS_PER_SESSION = 500;

function clampNonNegativeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

// ═══════════════════════════════════════════
// Events
// ═══════════════════════════════════════════

export function insertEvent(event: ToolEvent): void {
  const db = getDbOrNull();
  if (!db) return;

  try {
    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, project_dir)
       VALUES (?, ?)`,
    ).run(event.session_id, "");

    db.prepare(
      `UPDATE sessions
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`,
    ).run(event.session_id);

    const count = db.prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`,
    ).get(event.session_id) as { cnt: number } | undefined;

    if ((count?.cnt ?? 0) >= MAX_EVENTS_PER_SESSION) {
      db.prepare(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events WHERE session_id = ?
           ORDER BY id ASC LIMIT ?
         )`,
      ).run(event.session_id, Math.floor(MAX_EVENTS_PER_SESSION * 0.1));
    }

    db.prepare(
      `INSERT INTO events (session_id, event_type, tool, args, result, bytes_avoided, bytes_returned)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.session_id,
      event.event_type,
      event.tool,
      event.args,
      event.result,
      clampNonNegativeInt(event.bytes_avoided),
      clampNonNegativeInt(event.bytes_returned),
    );
  } catch {
    // Best-effort: must never throw and break the parent tool call
  }
}

export function getEvents(
  sessionId: string,
  opts?: { type?: EventType; limit?: number },
): ToolEvent[] {
  const db = getDbOrNull();
  if (!db) return [];

  try {
    const limit = opts?.limit ?? 100;

    if (opts?.type) {
      return db.prepare(
        `SELECT * FROM events WHERE session_id = ? AND event_type = ?
         ORDER BY id ASC LIMIT ?`,
      ).all(sessionId, opts.type, limit) as unknown as ToolEvent[];
    }

    return db.prepare(
      `SELECT * FROM events WHERE session_id = ?
       ORDER BY id ASC LIMIT ?`,
    ).all(sessionId, limit) as unknown as ToolEvent[];
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════
// Tool Call Counters
// ═══════════════════════════════════════════

export function incrementToolCall(
  sessionId: string,
  tool: string,
  bytesReturned: number = 0,
): void {
  const db = getDbOrNull();
  if (!db) return;

  try {
    const safeBytes = Number.isFinite(bytesReturned) && bytesReturned > 0
      ? Math.round(bytesReturned)
      : 0;
    db.prepare(
      `INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`,
    ).run(sessionId, tool, safeBytes);
  } catch {
    // Best-effort
  }
}

export function getToolCallStats(sessionId: string): ToolCallStats {
  const db = getDbOrNull();
  if (!db) return { totalCalls: 0, totalBytesReturned: 0, byTool: {} };

  try {
    const totals = db.prepare(
      `SELECT COALESCE(SUM(calls), 0) as calls,
              COALESCE(SUM(bytes_returned), 0) as bytes_returned
       FROM tool_calls WHERE session_id = ?`,
    ).get(sessionId) as { calls: number; bytes_returned: number } | undefined;

    const rows = db.prepare(
      `SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`,
    ).all(sessionId) as unknown as Array<{
      tool: string;
      calls: number;
      bytes_returned: number;
    }>;

    const byTool: ToolCallStats["byTool"] = {};
    for (const row of rows) {
      byTool[row.tool] = {
        calls: row.calls,
        bytesReturned: row.bytes_returned,
      };
    }

    return {
      totalCalls: totals?.calls ?? 0,
      totalBytesReturned: totals?.bytes_returned ?? 0,
      byTool,
    };
  } catch {
    return { totalCalls: 0, totalBytesReturned: 0, byTool: {} };
  }
}

// ═══════════════════════════════════════════
// Session Meta
// ═══════════════════════════════════════════

export function ensureSession(sessionId: string, projectDir: string): void {
  const db = getDbOrNull();
  if (!db) return;

  try {
    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`,
    ).run(sessionId, projectDir);
  } catch {
    // Best-effort
  }
}

export function getSessionMeta(sessionId: string): SessionMeta | null {
  const db = getDbOrNull();
  if (!db) return null;

  try {
    return db.prepare(
      `SELECT * FROM sessions WHERE session_id = ?`,
    ).get(sessionId) as unknown as SessionMeta | null;
  } catch {
    return null;
  }
}

export function deleteSession(sessionId: string): void {
  const db = getDbOrNull();
  if (!db) return;

  try {
    db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId);
  } catch {
    // Best-effort
  }
}

export function cleanupOldSessions(maxAgeDays: number = 7): number {
  const db = getDbOrNull();
  if (!db) return 0;

  try {
    const rows = db.prepare(
      `SELECT session_id FROM sessions
       WHERE started_at < datetime('now', ? || ' days')`,
    ).all(`-${maxAgeDays}`) as unknown as Array<{ session_id: string }>;

    for (const row of rows) {
      deleteSession(row.session_id);
    }

    return rows.length;
  } catch {
    return 0;
  }
}

export function getBytesAvoided(sessionId: string): number {
  const db = getDbOrNull();
  if (!db) return 0;

  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(bytes_avoided), 0) as total
       FROM events WHERE session_id = ? AND event_type = 'redirect'`,
    ).get(sessionId) as { total: number } | undefined;
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}
