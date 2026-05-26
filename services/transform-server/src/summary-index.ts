import Database from "better-sqlite3"
import { resolve } from "path"
import type { TurnSummary } from "./types.js"

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS turn_summaries (
  session_id    TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,
  overview      TEXT NOT NULL,
  intent        TEXT NOT NULL,
  actions_json  TEXT NOT NULL DEFAULT '[]',
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  outcome       TEXT NOT NULL DEFAULT 'unknown',
  errors_json   TEXT NOT NULL DEFAULT '[]',
  todos_json    TEXT NOT NULL DEFAULT '[]',
  confidence    REAL NOT NULL DEFAULT 0.5,
  reason        TEXT,
  generated_at  INTEGER NOT NULL,
  tokens_used   INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_summaries_session
  ON turn_summaries(session_id);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  session_id UNINDEXED,
  turn_index UNINDEXED,
  overview,
  intent,
  outcome,
  content='turn_summaries',
  content_rowid='rowid'
);

-- Keep FTS in sync
CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON turn_summaries BEGIN
  INSERT INTO summaries_fts(rowid, session_id, turn_index, overview, intent, outcome)
  VALUES (new.rowid, new.session_id, new.turn_index, new.overview, new.intent, new.outcome);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON turn_summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, session_id, turn_index, overview, intent, outcome)
  VALUES ('delete', old.rowid, old.session_id, old.turn_index, old.overview, old.intent, old.outcome);
END;

CREATE TRIGGER IF NOT EXISTS summaries_au AFTER UPDATE ON turn_summaries BEGIN
  INSERT INTO summaries_fts(summaries_fts, rowid, session_id, turn_index, overview, intent, outcome)
  VALUES ('delete', old.rowid, old.session_id, old.turn_index, old.overview, old.intent, old.outcome);
  INSERT INTO summaries_fts(rowid, session_id, turn_index, overview, intent, outcome)
  VALUES (new.rowid, new.session_id, new.turn_index, new.overview, new.intent, new.outcome);
END;
`

// ─── Index ────────────────────────────────────────────────────────────────────

export class SummaryIndex {
  private db: any

  constructor(dbPath?: string) {
    this.db = new (Database as any)(dbPath || ":memory:")
    this.db.exec("PRAGMA journal_mode=WAL;")
    this.db.exec(SCHEMA)
  }

  insert(summary: TurnSummary, sessionId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO turn_summaries
        (session_id, turn_index, overview, intent, actions_json, artifacts_json,
         outcome, errors_json, todos_json, confidence, reason, generated_at, tokens_used)
      VALUES
        (@session_id, @turn_index, @overview, @intent, @actions_json, @artifacts_json,
         @outcome, @errors_json, @todos_json, @confidence, @reason, @generated_at, @tokens_used)
    `)

    stmt.run({
      session_id: sessionId,
      turn_index: summary.turnIndex,
      overview: summary.overview,
      intent: summary.intent,
      actions_json: JSON.stringify(summary.actions),
      artifacts_json: JSON.stringify(summary.artifacts),
      outcome: summary.outcome,
      errors_json: JSON.stringify(summary.errors),
      todos_json: JSON.stringify(summary.todos),
      confidence: summary.confidence,
      reason: summary.reason || null,
      generated_at: summary.generatedAt,
      tokens_used: summary.tokensUsed || 0,
    })
  }

  get(sessionId: string, turnIndex: number): TurnSummary | null {
    const stmt = this.db.prepare("SELECT * FROM turn_summaries WHERE session_id = ? AND turn_index = ?")
    const row = stmt.get(sessionId, turnIndex) as any
    if (!row) return null
    return this.rowToSummary(row)
  }

  listBySession(sessionId: string): TurnSummary[] {
    const stmt = this.db.prepare(
      "SELECT * FROM turn_summaries WHERE session_id = ? ORDER BY turn_index ASC"
    )
    return (stmt.all(sessionId) as any[]).map((row) => this.rowToSummary(row))
  }

  search(sessionId: string, query: string, limit = 5): TurnSummary[] {
    if (!query.trim()) return this.listBySession(sessionId).slice(-limit)

    const escaped = query.replace(/['"*()]/g, " ")
    const ftsQuery = escaped.trim().split(/\s+/).map((w) => `"${w}"`).join(" ")

    let stmt: any
    try {
      stmt = this.db.prepare(`
        SELECT s.* FROM turn_summaries s
        JOIN summaries_fts f ON s.rowid = f.rowid
        WHERE f.session_id = ? AND summaries_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `)
    } catch {
      return []
    }

    return (stmt.all(sessionId, ftsQuery, limit) as any[]).map((row) => this.rowToSummary(row))
  }

  private rowToSummary(row: any): TurnSummary {
    return {
      turnIndex: row.turn_index,
      overview: row.overview,
      intent: row.intent,
      actions: JSON.parse(row.actions_json),
      artifacts: JSON.parse(row.artifacts_json),
      outcome: row.outcome,
      errors: JSON.parse(row.errors_json),
      todos: JSON.parse(row.todos_json),
      confidence: row.confidence,
      reason: row.reason || undefined,
      generatedAt: row.generated_at,
      tokensUsed: row.tokens_used,
    }
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM turn_summaries WHERE session_id = ?").run(sessionId)
  }

  close(): void {
    this.db.close()
  }
}
