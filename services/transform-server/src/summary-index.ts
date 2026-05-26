import Database from "better-sqlite3"
import { resolve } from "path"
import type { TurnSummary } from "./types.js"

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
// Global cache: content hash -> summary (cross-session)
CREATE TABLE IF NOT EXISTS global_summary_cache (
  content_hash  TEXT NOT NULL PRIMARY KEY,
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
  hit_count     INTEGER NOT NULL DEFAULT 1,
  last_hit_at   INTEGER NOT NULL
);

// Session-specific: session + turnIndex -> content_hash (for dedup within session)
CREATE TABLE IF NOT EXISTS session_turn_summaries (
  session_id    TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_hash
  ON session_turn_summaries(content_hash);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session
  ON session_turn_summaries(session_id);

// FTS for search within summaries (optional enhancement)
CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  content_hash UNINDEXED,
  overview,
  intent,
  outcome,
  content='global_summary_cache',
  content_rowid='rowid'
);

-- Keep FTS in sync
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
`

// ─── Index ────────────────────────────────────────────────────────────────────

export interface CachedSummary {
  summary: TurnSummary
  cached: boolean
}

export class SummaryIndex {
  private db: any
  private getByHashStmt: any
  private getHashStmt: any
  private updateHitStmt: any

  constructor(dbPath?: string) {
    this.db = new (Database as any)(dbPath || ":memory:")
    this.db.exec("PRAGMA journal_mode=WAL;")
    this.db.exec(SCHEMA)

    // Cache prepared statements for hot paths
    this.getByHashStmt = this.db.prepare(
      "SELECT * FROM global_summary_cache WHERE content_hash = ?"
    )
    this.getHashStmt = this.db.prepare(
      "SELECT content_hash FROM session_turn_summaries WHERE session_id = ? AND turn_index = ?"
    )
    this.updateHitStmt = this.db.prepare(
      "UPDATE global_summary_cache SET hit_count = hit_count + 1, last_hit_at = ? WHERE content_hash = ?"
    )
  }

  /**
   * Get summary by content hash (global cache lookup).
   * Returns null if not cached.
   */
  getByHash(contentHash: string): TurnSummary | null {
    const row = this.getByHashStmt.get(contentHash) as any
    if (!row) return null

    // Update hit count and timestamp (fire-and-forget, non-critical)
    this.updateHitStmt.run(Date.now(), contentHash)

    return this.rowToSummary(row)
  }

  /**
   * Get summary by session and turn index.
   * Returns null if not cached.
   */
  get(sessionId: string, turnIndex: number): TurnSummary | null {
    const hashRow = this.getHashStmt.get(sessionId, turnIndex) as any
    if (!hashRow) return null

    return this.getByHash(hashRow.content_hash)
  }

  /**
   * Store a generated summary.
   * Saves to both global cache (by hash) and session index.
   */
  insert(summary: TurnSummary, sessionId: string, contentHash: string): void {
    const tx = this.db.transaction(() => {
      // Insert/update global cache
      const cacheStmt = this.db.prepare(`
        INSERT OR REPLACE INTO global_summary_cache
          (content_hash, overview, intent, actions_json, artifacts_json,
           outcome, errors_json, todos_json, confidence, reason, generated_at, tokens_used, last_hit_at)
        VALUES
          (@content_hash, @overview, @intent, @actions_json, @artifacts_json,
           @outcome, @errors_json, @todos_json, @confidence, @reason, @generated_at, @tokens_used, @last_hit_at)
      `)

      cacheStmt.run({
        content_hash: contentHash,
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
        last_hit_at: Date.now(),
      })

      // Insert session index
      const idxStmt = this.db.prepare(`
        INSERT OR REPLACE INTO session_turn_summaries
          (session_id, turn_index, content_hash)
        VALUES
          (@session_id, @turn_index, @content_hash)
      `)

      idxStmt.run({
        session_id: sessionId,
        turn_index: summary.turnIndex,
        content_hash: contentHash,
      })
    })

    tx()
  }

  /**
   * Batch insert summaries (for efficiency).
   */
  insertBatch(summaries: Array<{ summary: TurnSummary; sessionId: string; contentHash: string }>): void {
    const tx = this.db.transaction(() => {
      const cacheStmt = this.db.prepare(`
        INSERT OR REPLACE INTO global_summary_cache
          (content_hash, overview, intent, actions_json, artifacts_json,
           outcome, errors_json, todos_json, confidence, reason, generated_at, tokens_used, last_hit_at)
        VALUES
          (@content_hash, @overview, @intent, @actions_json, @artifacts_json,
           @outcome, @errors_json, @todos_json, @confidence, @reason, @generated_at, @tokens_used, @last_hit_at)
      `)

      const idxStmt = this.db.prepare(`
        INSERT OR REPLACE INTO session_turn_summaries
          (session_id, turn_index, content_hash)
        VALUES
          (@session_id, @turn_index, @content_hash)
      `)

      for (const { summary, sessionId, contentHash } of summaries) {
        cacheStmt.run({
          content_hash: contentHash,
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
          last_hit_at: Date.now(),
        })

        idxStmt.run({
          session_id: sessionId,
          turn_index: summary.turnIndex,
          content_hash: contentHash,
        })
      }
    })

    tx()
  }

  /**
   * List all summaries for a session.
   */
  listBySession(sessionId: string): TurnSummary[] {
    const stmt = this.db.prepare(`
      SELECT c.* FROM global_summary_cache c
      JOIN session_turn_summaries s ON c.content_hash = s.content_hash
      WHERE s.session_id = ?
      ORDER BY s.turn_index ASC
    `)
    return (stmt.all(sessionId) as any[]).map((row) => this.rowToSummary(row))
  }

  /**
   * Search summaries by content.
   */
  search(query: string, limit = 5): TurnSummary[] {
    if (!query.trim()) return []

    const escaped = query.replace(/['"*()\-:^~]/g, " ")
    const ftsQuery = escaped.trim().split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ")

    let stmt: any
    try {
      stmt = this.db.prepare(`
        SELECT * FROM global_summary_cache
        WHERE content_hash IN (
          SELECT content_hash FROM summaries_fts WHERE summaries_fts MATCH ?
        )
        ORDER BY hit_count DESC, last_hit_at DESC
        LIMIT ?
      `)
    } catch {
      return []
    }

    return (stmt.all(ftsQuery, limit) as any[]).map((row) => this.rowToSummary(row))
  }

  private rowToSummary(row: any): TurnSummary {
    return {
      turnIndex: row.turn_index ?? 0,
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
    this.db.prepare("DELETE FROM session_turn_summaries WHERE session_id = ?").run(sessionId)
  }

  /**
   * Get cache statistics.
   */
  getStats(): { totalCacheEntries: number; totalHits: number } {
    const row = this.db.prepare(
      "SELECT COUNT(*) as totalCacheEntries, COALESCE(SUM(hit_count), 0) as totalHits FROM global_summary_cache"
    ).get() as any
    return { totalCacheEntries: row.totalCacheEntries, totalHits: row.totalHits }
  }

  close(): void {
    this.db.close()
  }
}
