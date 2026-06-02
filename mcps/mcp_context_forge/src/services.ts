/**
 * Service layer — shared services for all tools.
 *
 * - Lazy-initialized singletons for Executor, ContentStore, Session DB, Summary DB
 * - All DB operations centralized here
 * - No more duplicate lazy-init code scattered across tools
 */

import { Database, openDatabase } from "@context-forge/shared-types";
import { getSummariesDbPath } from "@context-forge/shared-types";
import { createHash } from "node:crypto";
import { existsSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Language, RuntimeInfo, RuntimeMap } from "./types.js";
import { SUMMARIES_DB_SCHEMA } from "@context-forge/shared-types";

// ── Project dir ─────────────────────────────────────────────────────────────

export function getProjectDir(): string {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.PROJECT_DIR ||
    process.cwd()
  );
}

// ── Executor ────────────────────────────────────────────────────────────────

let _executor: unknown = null;

export function getExecutor(): unknown {
  return _executor;
}

export function setExecutor(ex: unknown): void {
  _executor = ex;
}

// ── Content Store ───────────────────────────────────────────────────────────

let _store: unknown = null;

export function getStore(): unknown {
  return _store;
}

export function setStore(store: unknown): void {
  _store = store;
  (globalThis as Record<string, unknown>).__ctxStore = store;
}

// ── Runtime map ─────────────────────────────────────────────────────────────

let _runtimes: RuntimeMap | null = null;

export function getRuntimes(): RuntimeMap {
  if (!_runtimes) {
    throw new Error("exec-engine not initialized yet. Set it with setRuntimes().");
  }
  return _runtimes;
}

export function setRuntimes(r: RuntimeMap): void {
  _runtimes = r;
}

export function getRuntimeInfo(language: Language): RuntimeInfo {
  const runtimes = getRuntimes();
  const command = runtimes[language];
  return {
    command: command ?? "",
    available: command !== null && command !== undefined,
    version: command ? getVersion(command) : "not found",
    preferred: true,
  };
}

function getVersion(cmd: string): string {
  try {
    const out = execFileSync(cmd, ["--version"], { encoding: "utf-8", timeout: 1500 });
    return out.toString().trim();
  } catch {
    return "unknown";
  }
}

// ── Session DB ─────────────────────────────────────────────────────────────

let _sessionDb: Database | null = null;
let _sessionDbLazyPath: string | null = null;

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
`;

function resolveDataDir(): string {
  if (process.env.CLAUDE_PROJECT_DIR) return resolve(process.env.CLAUDE_PROJECT_DIR, ".ctx_plugin")
  if (process.env.PROJECT_DIR) return resolve(process.env.PROJECT_DIR, ".ctx_plugin")
  return resolve(process.cwd(), ".ctx_plugin")
}

function resolveSessionDbPath(projectDir?: string): string {
  const sessionsDir = resolve(resolveDataDir(), "sessions");

  const hashBase = projectDir || process.cwd();
  const hash = createHash("sha256").update(hashBase.toLowerCase()).digest("hex").slice(0, 16);
  return join(sessionsDir, `${hash}.db`);
}

export function initSessionDb(projectDir?: string): Database {
  if (!_sessionDb) {
    _sessionDbLazyPath = resolveSessionDbPath(projectDir);
    mkdirSync(_sessionDbLazyPath.replace(/[^/\\]+$/, ""), { recursive: true });
    _sessionDb = new Database(_sessionDbLazyPath);
    _sessionDb.exec(SESSION_DB_SCHEMA);

    // Migration for existing DBs
    try {
      const rawDb = _sessionDb.raw as { pragma?: (name: string) => Array<{ name: string }> };
      if (rawDb.pragma) {
        const colInfo = rawDb.pragma("table_xinfo(events)");
        const cols = new Set(colInfo.map((c: { name: string }) => c.name));
        if (!cols.has("category")) _sessionDb.exec("ALTER TABLE events ADD COLUMN category TEXT NOT NULL DEFAULT ''");
        if (!cols.has("priority")) _sessionDb.exec("ALTER TABLE events ADD COLUMN priority INTEGER NOT NULL DEFAULT 3");
        if (!cols.has("project_dir")) _sessionDb.exec("ALTER TABLE events ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
        if (!cols.has("source_hook")) _sessionDb.exec("ALTER TABLE events ADD COLUMN source_hook TEXT NOT NULL DEFAULT ''");
      }
    } catch {
      // best-effort migration
    }
  }
  return _sessionDb;
}

export function getSessionDb(): Database {
  if (!_sessionDb) return initSessionDb();
  return _sessionDb;
}

export function getSessionDbPath(): string {
  return _sessionDbLazyPath ?? resolveSessionDbPath();
}

export function closeSessionDb(): void {
  if (_sessionDb) {
    _sessionDb.close();
    _sessionDb = null;
  }
}

export function ensureSession(sessionId: string, projectDir: string): void {
  const db = getSessionDb();
  db.prepare(`INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`).run(sessionId, projectDir);
}

export function getLatestSessionId(): string | null {
  const db = getSessionDb();
  try {
    const row = db.prepare("SELECT session_id FROM sessions ORDER BY started_at DESC LIMIT 1").get() as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  } catch {
    return null;
  }
}

export function insertSessionEvent(ev: {
  session_id: string;
  type: string;
  category?: string;
  priority?: number;
  data?: string;
  tool?: string;
  args?: string;
  result?: string;
  bytes_avoided?: number;
  bytes_returned?: number;
  project_dir?: string;
  source_hook?: string;
}): void {
  const db = getSessionDb();
  const MAX_EVENTS_PER_SESSION = 500;
  const sessionId = ev.session_id;
  const category = ev.category ?? "";
  const priority = ev.priority ?? 3;
  const projectDir = ev.project_dir ?? "";
  const sourceHook = ev.source_hook ?? "";

  db.prepare(`INSERT OR IGNORE INTO sessions (session_id, project_dir) VALUES (?, ?)`).run(sessionId, projectDir);
  db.prepare(`UPDATE sessions SET last_event_at = datetime('now'), event_count = event_count + 1 WHERE session_id = ?`).run(sessionId);

  const count = db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined;
  if ((count?.cnt ?? 0) >= MAX_EVENTS_PER_SESSION) {
    db.prepare(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?)`).run(
      sessionId,
      Math.floor(MAX_EVENTS_PER_SESSION * 0.1)
    );
  }

  db.prepare(
    `INSERT INTO events (session_id, type, category, priority, data, tool, args, result, bytes_avoided, bytes_returned, project_dir, source_hook)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    ev.type,
    category,
    priority,
    ev.data ?? "",
    ev.tool ?? "",
    ev.args ?? "",
    ev.result ?? "",
    ev.bytes_avoided ?? 0,
    ev.bytes_returned ?? 0,
    projectDir,
    sourceHook
  );
}

export function getSessionEvents(
  sessionId: string,
  opts?: { type?: string; category?: string; minPriority?: number; limit?: number }
): Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }> {
  const db = getSessionDb();
  const limit = opts?.limit ?? 100;

  if (opts?.type && opts?.minPriority !== undefined) {
    return db.prepare(`SELECT * FROM events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`).all(sessionId, opts.type, opts.minPriority, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>;
  }
  if (opts?.type) {
    return db.prepare(`SELECT * FROM events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`).all(sessionId, opts.type, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>;
  }
  if (opts?.category) {
    return db.prepare(`SELECT * FROM events WHERE session_id = ? AND category = ? ORDER BY id ASC LIMIT ?`).all(sessionId, opts.category, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>;
  }
  return db.prepare(`SELECT * FROM events WHERE session_id = ? ORDER BY id ASC LIMIT ?`).all(sessionId, limit) as Array<{ id: number; session_id: string; type: string; category: string; priority: number; data: string; tool: string; project_dir: string; created_at: string }>;
}

export function deleteSessionById(sessionId: string): void {
  const db = getSessionDb();
  db.prepare(`DELETE FROM events WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM session_resume WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM sessions WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId);
}

export function cleanupOldSessions(maxAgeDays: number = 7): number {
  const db = getSessionDb();
  try {
    const rows = db.prepare(`SELECT session_id FROM sessions WHERE started_at < datetime('now', ? || ' days')`).all(`-${maxAgeDays}`) as Array<{ session_id: string }>;
    for (const row of rows) {
      deleteSessionById(row.session_id);
    }
    return rows.length;
  } catch {
    return 0;
  }
}

export function incrementCompactCount(sessionId: string): void {
  const db = getSessionDb();
  db.prepare(`UPDATE sessions SET compact_count = compact_count + 1 WHERE session_id = ?`).run(sessionId);
}

export function upsertResume(sessionId: string, snapshot: string, eventCount?: number): void {
  const db = getSessionDb();
  db.prepare(
    `INSERT INTO session_resume (session_id, snapshot, event_count) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET snapshot = excluded.snapshot, event_count = excluded.event_count, created_at = datetime('now'), consumed = 0`
  ).run(sessionId, snapshot, eventCount ?? 0);
}

export function getToolCallStats(sessionId: string): { totalCalls: number; totalBytesReturned: number; byTool: Record<string, { calls: number; bytesReturned: number }> } {
  const db = getSessionDb();
  try {
    const totals = db.prepare(`SELECT COALESCE(SUM(calls), 0) as calls, COALESCE(SUM(bytes_returned), 0) as bytes_returned FROM tool_calls WHERE session_id = ?`).get(sessionId) as { calls: number; bytes_returned: number } | undefined;
    const rows = db.prepare(`SELECT tool, calls, bytes_returned FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`).all(sessionId) as Array<{ tool: string; calls: number; bytes_returned: number }>;
    const byTool: Record<string, { calls: number; bytesReturned: number }> = {};
    for (const row of rows) byTool[row.tool] = { calls: row.calls, bytesReturned: row.bytes_returned };
    return { totalCalls: totals?.calls ?? 0, totalBytesReturned: totals?.bytes_returned ?? 0, byTool };
  } catch {
    return { totalCalls: 0, totalBytesReturned: 0, byTool: {} };
  }
}

export function getSessionMeta(sessionId: string): { session_id: string; project_dir: string; started_at: string; last_event_at: string | null; event_count: number; compact_count: number } | null {
  const db = getSessionDb();
  try {
    return db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId) as { session_id: string; project_dir: string; started_at: string; last_event_at: string | null; event_count: number; compact_count: number } | null;
  } catch {
    return null;
  }
}

export function getEventCount(sessionId: string): number {
  const db = getSessionDb();
  try {
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE session_id = ?`).get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ── Summary DB ─────────────────────────────────────────────────────────────

let _summaryDb: Database | null = null;

/**
 * Open (or create) the summaries database.
 *
 * The transform plugin writes summaries here; the MCP server reads them.
 * Path matches transform plugin's getSummariesDbPathInline():
 *   <cwd>/.ctx_plugin/data/summaries.db
 *
 * If the DB doesn't exist, it is created with the full schema (FTS5, triggers).
 * Uses WAL mode for concurrent read/write safety.
 */
export function openSummaryDb(): Database {
  if (_summaryDb) return _summaryDb;

  const path = getSummariesDbPath();
  const dir = path.replace(/[^/\\]+$/, "");

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _summaryDb = openDatabase(path);

  // Inject schema — same as what transform plugin creates via build-plugins.mjs.
  // The transform plugin owns writes; MCP is read-only in practice, but we open
  // read-write so we can create the DB on first use.
  try {
    _summaryDb.exec(SUMMARIES_DB_SCHEMA);
  } catch (err) {
    // Schema may already exist (CREATE TABLE IF NOT EXISTS is idempotent)
    if (err instanceof Error && !err.message.includes("table") && !err.message.includes("already exists")) {
      _summaryDb.close();
      _summaryDb = null;
      throw err;
    }
  }

  return _summaryDb;
}

export function closeSummaryDb(): void {
  if (_summaryDb) {
    _summaryDb.close();
    _summaryDb = null;
  }
}

export function getSummaryStats(): { totalSummaries: number; totalSessions: number; totalMessages: number; dbSizeBytes: number } {
  const db = openSummaryDb();
  const cacheRow = db.prepare(`SELECT COUNT(*) as c FROM global_summary_cache`).get() as { c: number };
  const sessionRow = db.prepare(`SELECT COUNT(DISTINCT session_id) as c FROM session_turn_summaries`).get() as { c: number };
  const msgRow = db.prepare(`SELECT COUNT(*) as c FROM turn_messages`).get() as { c: number };
  const dbPath = getSummariesDbPath();
  const size = existsSync(dbPath) ? statSync(dbPath).size : 0;
  return { totalSummaries: cacheRow.c, totalSessions: sessionRow.c, totalMessages: msgRow.c, dbSizeBytes: size };
}

export function searchSummaries(
  query: string,
  limit: number,
  sessionId?: string
): Array<{ sessionId: string; turnIndex: number; overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string }> {
  const db = openSummaryDb();
  const escaped = query.replace(/['"*()\-:^~]/g, " ").split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ");
  if (!escaped.trim()) return [];

  try {
    if (sessionId) {
      return db.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        JOIN summaries_fts f ON c.rowid = f.rowid
        WHERE idx.session_id = ? AND summaries_fts MATCH ?
        ORDER BY rank LIMIT ?`).all(sessionId, escaped, limit) as Array<{ sessionId: string; turnIndex: number; overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string }>;
    }
    return db.prepare(`
      SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
      JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
      JOIN summaries_fts f ON c.rowid = f.rowid
      WHERE summaries_fts MATCH ?
      ORDER BY rank LIMIT ?`).all(escaped, limit) as Array<{ sessionId: string; turnIndex: number; overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string }>;
  } catch {
    return [];
  }
}

export function listSummariesBySession(sessionId: string): Array<{ sessionId: string; turnIndex: number; overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string }> {
  const db = openSummaryDb();
  if (sessionId === "%") {
    return db.prepare(`SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash ORDER BY c.generated_at DESC LIMIT 50`).all() as Array<{ sessionId: string; turnIndex: number; overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string }>;
  }
  return db.prepare(`SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash WHERE idx.session_id = ? ORDER BY idx.turn_index ASC`).all(sessionId) as Array<{ sessionId: string; turnIndex: number; overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string }>;
}

export function getSummary(sessionId: string, turnIndex: number): { overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string } | null {
  const db = openSummaryDb();
  const row = db.prepare(`SELECT c.* FROM global_summary_cache c JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash WHERE idx.session_id = ? AND idx.turn_index = ?`).get(sessionId, turnIndex) as { overview: string; intent: string; outcome: string; confidence: number; startMsgId: string; endMsgId: string } | undefined;
  return row ?? null;
}

export function getTurnMessages(sessionId: string, turnIndex: number): Array<{ msgId: string; sessionId: string; turnIndex: number; role: string; content: string; toolCalls?: unknown; createdAt: number; seqInTurn: number }> {
  const db = openSummaryDb();
  const rows = db.prepare(`SELECT * FROM turn_messages WHERE session_id = ? AND turn_index = ? ORDER BY seq_in_turn ASC`).all(sessionId, turnIndex) as Array<{ msg_id: string; session_id: string; turn_index: number; role: string; content: string; tool_calls: string | null; created_at: number; seq_in_turn: number }>;
  return rows.map((r) => ({
    msgId: r.msg_id,
    sessionId: r.session_id,
    turnIndex: r.turn_index,
    role: r.role,
    content: r.content,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    createdAt: r.created_at,
    seqInTurn: r.seq_in_turn,
  }));
}

// ── Recall LLM ─────────────────────────────────────────────────────────────

let _recallLLM: { generate(prompt: string): Promise<string> } | null = null;

export function getRecallLLM(): typeof _recallLLM {
  return _recallLLM;
}

export function setRecallLLM(llm: typeof _recallLLM): void {
  _recallLLM = llm;
}

// ── Resume snapshot builder ─────────────────────────────────────────────────

export function buildResumeSnapshotFromEvents(
  events: Array<{ type: string; category: string; data: string }>,
  compactCount: number
): string {
  const byCategory: Record<string, typeof events> = {};
  for (const ev of events) {
    (byCategory[ev.category || "other"] ??= []).push(ev);
  }

  const sections: string[] = [];

  function dedupe(items: string[], max = 15): string[] {
    return [...new Set(items.filter((s) => s.length > 0))].slice(0, max);
  }

  const fileEvents = byCategory["file"] ?? [];
  if (fileEvents.length > 0) {
    const lines: string[] = [];
    const fileMap = new Map<string, { reads: number; writes: number }>();
    for (const ev of fileEvents) {
      let e = fileMap.get(ev.data);
      if (!e) { e = { reads: 0, writes: 0 }; fileMap.set(ev.data, e); }
      if (ev.type === "file_write") e.writes++;
      else e.reads++;
    }
    for (const [path, { reads, writes }] of Array.from(fileMap.entries()).slice(-12)) {
      const name = path.split("/").pop() ?? path;
      const parts: string[] = [];
      if (reads > 0) parts.push(`read×${reads}`);
      if (writes > 0) parts.push(`write×${writes}`);
      lines.push(`  ${name} (${parts.join(", ")})`);
    }
    if (lines.length > 0) sections.push(`Files (${fileMap.size} tracked):\n${lines.join("\n")}`);
  }

  const gitEvents = byCategory["git"] ?? [];
  if (gitEvents.length > 0) {
    sections.push(`Git operations (${gitEvents.length}):\n${dedupe(gitEvents.map((e) => `  ${e.data}`), 8).join("\n")}`);
  }

  const errorEvents = byCategory["error"] ?? [];
  if (errorEvents.length > 0) {
    sections.push(`Errors encountered:\n${dedupe(errorEvents.map((e) => `  - ${e.data}`), 5).join("\n")}`);
  }

  const mcpEvents = byCategory["mcp"] ?? [];
  if (mcpEvents.length > 0) {
    const counts = new Map<string, number>();
    for (const ev of mcpEvents) counts.set(ev.data, (counts.get(ev.data) ?? 0) + 1);
    const lines: string[] = [];
    for (const [name, count] of counts) lines.push(`  ${name} (${count}×)`);
    sections.push(`MCP tools used:\n${lines.join("\n")}`);
  }

  if (sections.length === 0) return "";

  return `=== Session Resume (compact #${compactCount}, ${events.length} events) ===\nFor full details on any item, use: ctx_content_search(query="...", source="session-events")\n\n${sections.join("\n\n")}`;
}
