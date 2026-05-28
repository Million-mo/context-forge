/**
 * schema.ts — Canonical SQLite schema for the shared summaries database.
 *
 * Used by:
 *   - transform.ts (ctx_plugin) — writes summaries and messages
 *   - mcp_ctx_summary (MCP server) — reads summaries and messages
 *
 * If you change this schema, both consumers must be updated and
 * a DB migration step may be needed.
 *
 * Version: 1
 */

export const SUMMARIES_DB_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_summary_cache (
  content_hash TEXT NOT NULL PRIMARY KEY,
  overview TEXT NOT NULL,
  intent TEXT NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT 'unknown',
  errors_json TEXT NOT NULL DEFAULT '[]',
  todos_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  reason TEXT,
  generated_at INTEGER NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  hit_count INTEGER NOT NULL DEFAULT 1,
  last_hit_at INTEGER NOT NULL,
  start_msg_id TEXT NOT NULL,
  end_msg_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_turn_summaries (
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_hash ON session_turn_summaries(content_hash);
CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_turn_summaries(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content_hash UNINDEXED,
  overview,
  intent,
  outcome,
  content='global_summary_cache',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON global_summary_cache BEGIN
  INSERT INTO summaries_fts(rowid, content_hash, overview, intent, outcome)
  VALUES (new.rowid, new.content_hash, new.overview, new.intent, new.outcome);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON global_summary_cache BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content_hash, overview, intent, outcome)
  VALUES ('delete', old.rowid, old.content_hash, old.overview, old.intent, old.outcome);
END;

CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON global_summary_cache BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, content_hash, overview, intent, outcome)
  VALUES ('delete', old.rowid, old.content_hash, old.overview, old.intent, old.outcome);
  INSERT INTO summaries_fts(rowid, content_hash, overview, intent, outcome)
  VALUES (new.rowid, new.content_hash, new.overview, new.intent, new.outcome);
END;

CREATE TABLE IF NOT EXISTS turn_messages (
  msg_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  created_at INTEGER NOT NULL,
  seq_in_turn INTEGER NOT NULL,
  PRIMARY KEY (msg_id)
);
CREATE INDEX IF NOT EXISTS idx_turn_messages_lookup ON turn_messages(session_id, turn_index, seq_in_turn);
`
