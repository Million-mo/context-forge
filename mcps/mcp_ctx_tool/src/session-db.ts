/**
 * Session event store for mcp_ctx_tool.
 *
 * Stores classified tool call events, session metadata, resume snapshots,
 * tool-call statistics, and project-wide event search.
 *
 * Event categories (ported from context-mode's SessionDB):
 *   file | git | task | error | decision | rule | env | cwd
 *
 * Priority tiers:
 *   1 = critical (files, rules, decisions, tasks)
 *   2 = high     (git, errors)
 *   3 = medium   (env, role)
 *   4 = low      (data, intent)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { Database } from "@context-forge/shared-types/db";

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

/** Event categories for structured classification. */
export type EventCategory =
  | "file"
  | "git"
  | "task"
  | "error"
  | "decision"
  | "rule"
  | "env"
  | "cwd"
  | "role"
  | "skill"
  | "subagent"
  | "data"
  | "intent"
  | "mcp";

/** A classified session event. */
export interface SessionEvent {
  id?: number;
  session_id: string;
  type: string;
  category: EventCategory;
  priority: number;
  data: string;
  tool?: string;
  args?: string;
  result?: string;
  bytes_avoided?: number;
  bytes_returned?: number;
  project_dir?: string;
  source_hook?: string;
  created_at?: string;
}

/** Legacy event type — kept for backward compat with existing callers. */
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
  /** Optional classified fields (new). */
  category?: EventCategory;
  priority?: number;
}

export interface SessionMeta {
  session_id: string;
  project_dir: string;
  started_at: string;
  last_event_at: string | null;
  event_count: number;
  compact_count: number;
}

export interface ToolCallStats {
  totalCalls: number;
  totalBytesReturned: number;
  byTool: Record<string, { calls: number; bytesReturned: number }>;
}

export interface ResumeRow {
  snapshot: string;
  event_count: number;
  consumed: number;
}

export interface StoredEvent {
  id: number;
  session_id: string;
  type: string;
  category: string;
  priority: number;
  data: string;
  tool: string;
  project_dir: string;
  created_at: string;
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

const SESSION_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL PRIMARY KEY,
  project_dir TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_event_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  compact_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 3,
  data TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  args TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '',
  bytes_avoided INTEGER NOT NULL DEFAULT 0,
  bytes_returned INTEGER NOT NULL DEFAULT 0,
  project_dir TEXT NOT NULL DEFAULT '',
  source_hook TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_category ON events(session_id, category);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(session_id, project_dir);

CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  bytes_returned INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, tool)
);

CREATE TABLE IF NOT EXISTS session_resume (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed INTEGER NOT NULL DEFAULT 0
);
`

export function initSessionDb(projectDir?: string): void {
  if (!_db) {
    _dbLazyPath = resolveSessionDbPath(projectDir);
    _db = new Database(_dbLazyPath);
    _db.exec(SESSION_DB_SCHEMA);

    // Migration: add category/priority columns for existing DBs
    try {
      const colInfo = _db.raw.pragma("table_xinfo(events)") as Array<{ name: string }>;
      if (!colInfo) return;
      const cols = new Set(colInfo.map((c) => c.name));
      if (!cols.has("category")) {
        _db.exec("ALTER TABLE events ADD COLUMN category TEXT NOT NULL DEFAULT ''");
      }
      if (!cols.has("priority")) {
        _db.exec("ALTER TABLE events ADD COLUMN priority INTEGER NOT NULL DEFAULT 3");
      }
      if (!cols.has("project_dir")) {
        _db.exec("ALTER TABLE events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
      }
      if (!cols.has("source_hook")) {
        _db.exec("ALTER TABLE events ADD COLUMN source_hook TEXT NOT NULL DEFAULT ''");
      }
    } catch {
      // best-effort migration
    }
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

/**
 * Insert a classified session event with FIFO eviction.
 * Also accepts legacy ToolEvent shape for backward compat.
 */
export function insertEvent(event: SessionEvent | ToolEvent): void {
  const db = getDbOrNull();
  if (!db) return;

  try {
    const sessionId = event.session_id;
    // Support both legacy ToolEvent and new SessionEvent shapes
    const type = "event_type" in event ? event.event_type : event.type;
    const category = event.category ?? "";
    const priority = event.priority ?? 3;
    const data = "args" in event ? JSON.stringify({ args: event.args, result: event.result }) : (event.data ?? "");
    const tool = "tool" in event ? event.tool : (event.tool ?? "");
    const args = "args" in event ? event.args : (event.args ?? "");
    const result = "result" in event ? event.result : (event.result ?? "");
    const bytesAvoided = clampNonNegativeInt("bytes_avoided" in event ? event.bytes_avoided : 0);
    const bytesReturned = clampNonNegativeInt("bytes_returned" in event ? event.bytes_returned : 0);
    const projectDir = event.project_dir ?? "";
    const sourceHook = event.source_hook ?? "";

    db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, project_dir)
       VALUES (?, ?)`,
    ).run(sessionId, projectDir);

    db.prepare(
      `UPDATE sessions
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`,
    ).run(sessionId);

    const count = db.prepare(
      `SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`,
    ).get(sessionId) as { cnt: number } | undefined;

    if ((count?.cnt ?? 0) >= MAX_EVENTS_PER_SESSION) {
      db.prepare(
        `DELETE FROM events WHERE id IN (
           SELECT id FROM events WHERE session_id = ?
           ORDER BY id ASC LIMIT ?
         )`,
      ).run(sessionId, Math.floor(MAX_EVENTS_PER_SESSION * 0.1));
    }

    db.prepare(
      `INSERT INTO events (session_id, type, category, priority, data, tool, args, result, bytes_avoided, bytes_returned, project_dir, source_hook)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, type, category, priority, data, tool, args, result, bytesAvoided, bytesReturned, projectDir, sourceHook);
  } catch {
    // Best-effort: must never throw and break the parent tool call
  }
}

export function getEvents(
  sessionId: string,
  opts?: { type?: string; category?: EventCategory; minPriority?: number; limit?: number },
): StoredEvent[] {
  const db = getDbOrNull();
  if (!db) return [];

  try {
    const limit = opts?.limit ?? 100;

    if (opts?.type && opts?.minPriority !== undefined) {
      return db.prepare(
        `SELECT * FROM events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`,
      ).all(sessionId, opts.type, opts.minPriority, limit) as unknown as StoredEvent[];
    }
    if (opts?.type) {
      return db.prepare(
        `SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`,
      ).all(sessionId, opts.type, limit) as unknown as StoredEvent[];
    }
    if (opts?.category) {
      return db.prepare(
        `SELECT * FROM events WHERE session_id = ? AND category = ? ORDER BY id ASC LIMIT ?`,
      ).all(sessionId, opts.category, limit) as unknown as StoredEvent[];
    }
    if (opts?.minPriority !== undefined) {
      return db.prepare(
        `SELECT * FROM events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`,
      ).all(sessionId, opts.minPriority, limit) as unknown as StoredEvent[];
    }

    return db.prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?`,
    ).all(sessionId, limit) as unknown as StoredEvent[];
  } catch {
    return [];
  }
}

export function getEventCount(sessionId: string): number {
  const db = getDbOrNull();
  if (!db) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`).get(sessionId) as { cnt: number };
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Search events by text query scoped to a project directory.
 * Case-insensitive LIKE across data + category columns.
 */
export function searchEvents(
  query: string,
  projectDir: string,
  limit: number = 20,
  source?: string,
): Array<{ id: number; session_id: string; category: string; type: string; data: string; created_at: string }> {
  const db = getDbOrNull();
  if (!db) return [];

  try {
    const escapedQuery = query.replace(/[%_]/g, (char) => "\\" + char);
    const sourceParam = source ?? null;
    return db.prepare(
      `SELECT id, session_id, category, type, data, created_at
       FROM events
       WHERE project_dir = ?
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`,
    ).all(projectDir, escapedQuery, escapedQuery, sourceParam, sourceParam, limit) as Array<{
      id: number; session_id: string; category: string; type: string; data: string; created_at: string;
    }>;
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

export function getSessionStats(sessionId: string): SessionMeta | null {
  return getSessionMeta(sessionId);
}

export function incrementCompactCount(sessionId: string): void {
  const db = getDbOrNull();
  if (!db) return;
  try {
    db.prepare(`UPDATE sessions SET compact_count = compact_count + 1 WHERE session_id = ?`).run(sessionId);
  } catch {
    // best-effort
  }
}

export function getLatestSessionId(): string | null {
  const db = getDbOrNull();
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT session_id FROM sessions ORDER BY started_at DESC LIMIT 1",
    ).get() as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════
// Resume Snapshots
// ═══════════════════════════════════════════

export function upsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
  const db = getDbOrNull();
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`,
    ).run(sessionId, snapshot, eventCount ?? 0);
  } catch {
    // best-effort
  }
}

export function getResume(sessionId: string): ResumeRow | null {
  const db = getDbOrNull();
  if (!db) return null;
  try {
    return db.prepare(
      "SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?",
    ).get(sessionId) as unknown as ResumeRow | null;
  } catch {
    return null;
  }
}

export function markResumeConsumed(sessionId: string): void {
  const db = getDbOrNull();
  if (!db) return;
  try {
    db.prepare("UPDATE session_resume SET consumed = 1 WHERE session_id = ?").run(sessionId);
  } catch {
    // best-effort
  }
}

/**
 * Atomically claim the most recent unconsumed resume snapshot,
 * excluding `currentSessionId` to prevent self-injection.
 */
export function claimLatestUnconsumedResume(
  currentSessionId: string,
): { sessionId: string; snapshot: string } | null {
  const db = getDbOrNull();
  if (!db) return null;
  try {
    // SQLite doesn't support RETURNING in older versions, so use two-step
    const row = db.prepare(
      `SELECT id, session_id, snapshot FROM session_resume
       WHERE consumed = 0 AND session_id != ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ).get(currentSessionId) as { id: number; session_id: string; snapshot: string } | undefined;
    if (!row) return null;
    db.prepare("UPDATE session_resume SET consumed = 1 WHERE id = ?").run(row.id);
    return { sessionId: row.session_id, snapshot: row.snapshot };
  } catch {
    return null;
  }
}

export function deleteSession(sessionId: string): void {
  const db = getDbOrNull();
  if (!db) return;

  try {
    db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
    db.prepare(`DELETE FROM session_resume WHERE session_id = ?`).run(sessionId);
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
       FROM events WHERE session_id = ? AND type = 'redirect'`,
    ).get(sessionId) as { total: number } | undefined;
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}
