/**
 * Session DB — event tracking for ctx_session and tool execution analysis.
 *
 * Bun SQLite (bun:sqlite) implementation, identical schema to the Node.js
 * version in mcps/mcp_context_forge/src/services.ts.
 *
 * This DB is written by:
 *   - tool.execute.after hook (plugin)
 *
 * This DB is read by:
 *   - ctx_session tool (plugin)
 */

import { createHash } from "node:crypto"
import { resolve, join } from "node:path"
import { homedir } from "node:os"
import { mkdirSync } from "node:fs"
import type { Database } from "@context-forge/shared-types"

// ─── DB Path ─────────────────────────────────────────────────────────────────

function resolveDataDir(): string {
  if (process.env.CTX_PLUGIN_DATA_DIR) return resolve(process.env.CTX_PLUGIN_DATA_DIR)
  if (process.env.XDG_DATA_HOME) return resolve(process.env.XDG_DATA_HOME, "ctx_plugin")
  if (process.platform === "win32") {
    return resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "ctx_plugin")
  }
  return resolve(homedir(), ".local", "share", "ctx_plugin")
}

function hashProjectDir(): string {
  const base = process.cwd()
  return createHash("sha256").update(base.toLowerCase()).digest("hex").slice(0, 16)
}

function resolveSessionDbPath(): string {
  const sessionsDir = join(resolveDataDir(), "sessions")
  const hash = hashProjectDir()
  return join(sessionsDir, `${hash}.db`)
}

// ─── Schema ─────────────────────────────────────────────────────────────────

const SCHEMA = `
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

// ─── DB Manager ───────────────────────────────────────────────────────────────

let _db: Database | null = null

function openDb(): Database {
  if (_db) return _db

  const dbPath = resolveSessionDbPath()
  const dir = dbPath.replace(/[^/\\]+$/, "")
  mkdirSync(dir, { recursive: true })

  // bun:sqlite — DatabaseSync is synchronous
  const { Database } = require("bun:sqlite")
  _db = new Database(dbPath) as unknown as Database

  _db.exec("PRAGMA journal_mode = DELETE")
  _db.exec("PRAGMA synchronous = NORMAL")

  _db.exec(SCHEMA)

  return _db
}

export function getSessionDb(): Database {
  return openDb()
}

// ─── Session Management ───────────────────────────────────────────────────────

export function ensureSession(sessionId: string, projectDir: string): void {
  const db = getSessionDb()
  db.prepare(`INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`).run(sessionId, projectDir)
}

export function getLatestSessionId(): string | null {
  const db = getSessionDb()
  try {
    const row = db.prepare(
      "SELECT session_id FROM sessions ORDER BY last_event_at DESC, started_at DESC LIMIT 1"
    ).get() as { session_id?: string } | undefined
    return row?.session_id ?? null
  } catch {
    return null
  }
}

// ─── Event Logging ──────────────────────────────────────────────────────────

export function insertSessionEvent(ev: {
  session_id: string
  type: string
  category?: string
  priority?: number
  data?: string
  tool?: string
  args?: string
  result?: string
  bytes_avoided?: number
  bytes_returned?: number
  project_dir?: string
  source_hook?: string
}): void {
  const db = getSessionDb()
  const sessionId = ev.session_id
  const category = ev.category ?? ""
  const priority = ev.priority ?? 3
  const projectDir = ev.project_dir ?? ""
  const sourceHook = ev.source_hook ?? ""

  ensureSession(sessionId, projectDir)
  db.prepare(
    `UPDATE sessions SET last_event_at = datetime('now'), event_count = event_count + 1 WHERE session_id = ?`
  ).run(sessionId)

  const count = db.prepare(
    `SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`
  ).get(sessionId) as { cnt: number } | undefined

  const MAX_EVENTS = 500
  if ((count?.cnt ?? 0) >= MAX_EVENTS) {
    db.prepare(
      `DELETE FROM events WHERE id IN (SELECT id FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?)`
    ).run(sessionId, Math.floor(MAX_EVENTS * 0.1))
  }

  db.prepare(
    `INSERT INTO events (session_id, type, category, priority, data, tool, args, result, bytes_avoided, bytes_returned, project_dir, source_hook)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId, ev.type, category, priority,
    ev.data ?? "", ev.tool ?? "", ev.args ?? "", ev.result ?? "",
    ev.bytes_avoided ?? 0, ev.bytes_returned ?? 0,
    projectDir, sourceHook
  )
}

export function getSessionEvents(
  sessionId: string,
  opts?: { type?: string; category?: string; minPriority?: number; limit?: number }
): Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }> {
  const db = getSessionDb()
  const limit = opts?.limit ?? 100

  if (opts?.type && opts?.minPriority !== undefined) {
    return db.prepare(
      `SELECT * FROM events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`
    ).all(sessionId, opts.type, opts.minPriority, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>
  }
  if (opts?.type) {
    return db.prepare(
      `SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`
    ).all(sessionId, opts.type, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>
  }
  if (opts?.category) {
    return db.prepare(
      `SELECT * FROM events WHERE session_id = ? AND category = ? ORDER BY id ASC LIMIT ?`
    ).all(sessionId, opts.category, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>
  }
  return db.prepare(
    `SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?`
  ).all(sessionId, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>
}

export function getSessionMeta(sessionId: string): {
  session_id: string; project_dir: string; started_at: string;
  last_event_at: string | null; event_count: number; compact_count: number
} | null {
  const db = getSessionDb()
  try {
    return db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as {
      session_id: string; project_dir: string; started_at: string;
      last_event_at: string | null; event_count: number; compact_count: number
    } | null
  } catch {
    return null
  }
}

export function getEventCount(sessionId: string): number {
  const db = getSessionDb()
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined
    return row?.cnt ?? 0
  } catch {
    return 0
  }
}

export function incrementCompactCount(sessionId: string): void {
  const db = getSessionDb()
  db.prepare(`UPDATE sessions SET compact_count = compact_count + 1 WHERE session_id = ?`).run(sessionId)
}

export function upsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
  const db = getSessionDb()
  db.prepare(
    `INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       snapshot = excluded.snapshot,
       event_count = excluded.event_count,
       created_at = datetime('now'),
       consumed = 0`
  ).run(sessionId, snapshot, eventCount ?? 0)
}

export function getToolCallStats(sessionId: string): {
  totalCalls: number; totalBytesReturned: number;
  byTool: Record<string, { calls: number; bytesReturned: number }>
} {
  const db = getSessionDb()
  try {
    const totals = db.prepare(
      `SELECT COALESCE(SUM(calls), 0) as calls, COALESCE(SUM(bytes_returned), 0) as bytes_returned FROM tool_calls WHERE session_id = ?`
    ).get(sessionId) as { calls: number; bytes_returned: number } | undefined
    const rows = db.prepare(
      `SELECT tool, calls, bytes_returned FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`
    ).all(sessionId) as Array<{ tool: string; calls: number; bytes_returned: number }>
    const byTool: Record<string, { calls: number; bytesReturned: number }> = {}
    for (const row of rows) byTool[row.tool] = { calls: row.calls, bytesReturned: row.bytes_returned }
    return { totalCalls: totals?.calls ?? 0, totalBytesReturned: totals?.bytes_returned ?? 0, byTool }
  } catch {
    return { totalCalls: 0, totalBytesReturned: 0, byTool: {} }
  }
}

export function deleteSessionById(sessionId: string): void {
  const db = getSessionDb()
  db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM session_resume WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId)
}

// ─── Tool Call Tracking ──────────────────────────────────────────────────────

export function trackToolCall(sessionId: string, tool: string, bytesReturned: number): void {
  const db = getSessionDb()
  db.prepare(
    `INSERT INTO tool_calls (session_id, tool, calls, bytes_returned, updated_at)
     VALUES (?, ?, 1, ?, datetime('now'))
     ON CONFLICT(session_id, tool) DO UPDATE SET
       calls = calls + 1,
       bytes_returned = bytes_returned + excluded.bytes_returned,
       updated_at = datetime('now')`
  ).run(sessionId, tool, bytesReturned)
}
