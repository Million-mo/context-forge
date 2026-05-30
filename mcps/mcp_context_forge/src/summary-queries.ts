/**
 * Summary query functions — extracted from mcp_ctx_summary/server.ts.
 *
 * Pure database access layer over summaries.db.
 * Used by mcp_context_forge (unified MCP) and can replace
 * the inline logic in the old mcp_ctx_summary server.
 */

import { Database, getSummariesDbPath } from "@context-forge/shared-types";
import type {
  StoredMessage,
  SummaryWithSession,
  TurnSummary,
} from "@context-forge/shared-types";
import { existsSync, statSync } from "fs";

// ── Row types ────────────────────────────────────────────────────────────────

interface SummaryRow {
  turn_index: number;
  overview: string;
  intent: string;
  actions_json: string;
  artifacts_json: string;
  outcome: string;
  errors_json: string;
  todos_json: string;
  confidence: number;
  reason: string | null;
  generated_at: number;
  tokens_used: number;
  start_msg_id: string;
  end_msg_id: string;
}

interface SummaryRowWithSession extends SummaryRow {
  session_id: string;
  turn_index: number;
}

interface MessageRow {
  msg_id: string;
  session_id: string;
  turn_index: number;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: number;
  seq_in_turn: number;
}

// ── DB singleton ──────────────────────────────────────────────────────────────

let db: Database | null = null;

export function openSummaryDb(): Database {
  if (db) return db;
  const path = getSummariesDbPath();
  if (!existsSync(path)) {
    throw new Error(
      `Database not found at ${path}. Enable the transform plugin in ctx_plugin first.`,
    );
  }
  db = new Database(path, { readonly: true });
  return db;
}

export function closeSummaryDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToSummary(row: SummaryRow): TurnSummary {
  return {
    turnIndex: row.turn_index,
    overview: row.overview,
    intent: row.intent,
    actions: JSON.parse(row.actions_json),
    artifacts: JSON.parse(row.artifacts_json),
    outcome: row.outcome as TurnSummary["outcome"],
    errors: JSON.parse(row.errors_json),
    todos: JSON.parse(row.todos_json),
    confidence: row.confidence,
    reason: row.reason || undefined,
    generatedAt: row.generated_at,
    tokensUsed: row.tokens_used,
    startMsgId: row.start_msg_id,
    endMsgId: row.end_msg_id,
  };
}

function rowToSummaryWithSession(row: SummaryRowWithSession): SummaryWithSession {
  return { ...rowToSummary(row), sessionId: row.session_id };
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    msgId: row.msg_id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    role: row.role as "user" | "assistant" | "tool",
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    createdAt: row.created_at,
    seqInTurn: row.seq_in_turn,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

export function searchSummaries(
  query: string,
  limit: number,
  sessionId?: string,
): SummaryWithSession[] {
  const database = openSummaryDb();
  const escaped = query
    .replace(/['"*()\-:^~]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replace(/"/g, '""')}"`)
    .join(" ");

  if (!escaped.trim()) {
    return listBySession(sessionId || "%");
  }

  let rows: SummaryRowWithSession[] = [];

  try {
    let stmt;
    if (sessionId) {
      stmt = database.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        JOIN summaries_fts f ON c.rowid = f.rowid
        WHERE idx.session_id = ? AND summaries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      rows = stmt.all(sessionId, escaped, limit) as SummaryRowWithSession[];
    } else {
      stmt = database.prepare(`
        SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
        JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
        JOIN summaries_fts f ON c.rowid = f.rowid
        WHERE summaries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      rows = stmt.all(escaped, limit) as SummaryRowWithSession[];
    }
    if (rows.length > 0) {
      return rows.map(rowToSummaryWithSession);
    }
  } catch {
    // FTS error — fall through to LIKE
  }

  const escapedQuery = query.replace(/[%_]/g, "\\$&");
  const likePattern = `%${escapedQuery}%`;
  if (sessionId) {
    rows = database
      .prepare(
        `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
         JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
         WHERE idx.session_id = ? AND (c.intent LIKE ? OR c.overview LIKE ?)
         ORDER BY c.generated_at DESC LIMIT ?`,
      )
      .all(sessionId, likePattern, likePattern, limit) as SummaryRowWithSession[];
  } else {
    rows = database
      .prepare(
        `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
         JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
         WHERE c.intent LIKE ? OR c.overview LIKE ?
         ORDER BY c.generated_at DESC LIMIT ?`,
      )
      .all(likePattern, likePattern, limit) as SummaryRowWithSession[];
  }
  return rows.map(rowToSummaryWithSession);
}

// ── List ──────────────────────────────────────────────────────────────────────

export function listBySession(sessionId: string): SummaryWithSession[] {
  const database = openSummaryDb();
  let rows: SummaryRowWithSession[];
  if (sessionId === "%") {
    rows = database
      .prepare(
        `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
         JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
         ORDER BY c.generated_at DESC LIMIT 50`,
      )
      .all() as SummaryRowWithSession[];
  } else {
    rows = database
      .prepare(
        `SELECT c.*, idx.session_id, idx.turn_index FROM global_summary_cache c
         JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
         WHERE idx.session_id = ?
         ORDER BY idx.turn_index ASC`,
      )
      .all(sessionId) as SummaryRowWithSession[];
  }
  return rows.map(rowToSummaryWithSession);
}

// ── Get single ────────────────────────────────────────────────────────────────

export function getSummary(
  sessionId: string,
  turnIndex: number,
): TurnSummary | null {
  const database = openSummaryDb();
  const row = database
    .prepare(
      `SELECT c.* FROM global_summary_cache c
       JOIN session_turn_summaries idx ON c.content_hash = idx.content_hash
       WHERE idx.session_id = ? AND idx.turn_index = ?`,
    )
    .get(sessionId, turnIndex) as SummaryRow | undefined;
  return row ? rowToSummary(row) : null;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function getMessages(
  sessionId: string,
  turnIndex: number,
): StoredMessage[] {
  const database = openSummaryDb();
  const rows = database
    .prepare(
      `SELECT * FROM turn_messages
       WHERE session_id = ? AND turn_index = ?
       ORDER BY seq_in_turn ASC`,
    )
    .all(sessionId, turnIndex) as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessagesByRange(
  startMsgId: string,
  endMsgId: string,
): StoredMessage[] {
  const database = openSummaryDb();
  const rows = database
    .prepare(
      `SELECT * FROM turn_messages
       WHERE msg_id >= ? AND msg_id <= ?
       ORDER BY seq_in_turn ASC`,
    )
    .all(startMsgId, endMsgId) as MessageRow[];
  return rows.map(rowToMessage);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function getSummaryStats(): {
  totalSummaries: number;
  totalSessions: number;
  totalMessages: number;
  dbSizeBytes: number;
} {
  const database = openSummaryDb();
  const cacheRow = database
    .prepare(`SELECT COUNT(*) as c FROM global_summary_cache`)
    .get() as { c: number };
  const sessionRow = database
    .prepare(`SELECT COUNT(DISTINCT session_id) as c FROM session_turn_summaries`)
    .get() as { c: number };
  const msgRow = database
    .prepare(`SELECT COUNT(*) as c FROM turn_messages`)
    .get() as { c: number };
  const dbPath = getSummariesDbPath();
  const size = existsSync(dbPath) ? statSync(dbPath).size : 0;
  return {
    totalSummaries: cacheRow.c,
    totalSessions: sessionRow.c,
    totalMessages: msgRow.c,
    dbSizeBytes: size,
  };
}
