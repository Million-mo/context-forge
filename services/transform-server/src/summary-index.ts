import Database from "better-sqlite3"
import { resolve } from "path"
import type { TurnSummary, StoredMessage } from "./types.js"

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
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
  last_hit_at   INTEGER NOT NULL,
  start_msg_id  TEXT NOT NULL,
  end_msg_id    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_turn_summaries (
  session_id    TEXT NOT NULL,
  turn_index    INTEGER NOT NULL,
  content_hash  TEXT NOT NULL,
  PRIMARY KEY (session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_hash ON session_turn_summaries(content_hash);
CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_turn_summaries(session_id);

CREATE TABLE IF NOT EXISTS turn_messages (
  msg_id       TEXT NOT NULL PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn_index   INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  tool_calls   TEXT,
  created_at   INTEGER NOT NULL,
  seq_in_turn  INTEGER NOT NULL,
  FOREIGN KEY (session_id, turn_index) REFERENCES session_turn_summaries(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON turn_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_turn ON turn_messages(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_messages_session_turn ON turn_messages(session_id, turn_index, seq_in_turn);

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

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  turn_index UNINDEXED,
  role,
  content,
  tool_calls,
  content='turn_messages',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON turn_messages BEGIN
  INSERT INTO messages_fts(rowid, session_id, turn_index, role, content, tool_calls)
  VALUES (new.rowid, new.session_id, new.turn_index, new.role, new.content, new.tool_calls);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON turn_messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, session_id, turn_index, role, content, tool_calls)
  VALUES ('delete', old.rowid, old.session_id, old.turn_index, old.role, old.content, old.tool_calls);
END;

CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON turn_messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, session_id, turn_index, role, content, tool_calls)
  VALUES ('delete', old.rowid, old.session_id, old.turn_index, old.role, old.content, old.tool_calls);
  INSERT INTO messages_fts(rowid, session_id, turn_index, role, content, tool_calls)
  VALUES (new.rowid, new.session_id, new.turn_index, new.role, new.content, new.tool_calls);
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
   * Store a generated summary with its messages.
   * Saves to both global cache (by hash) and session index, plus messages.
   */
  insert(summary: TurnSummary, sessionId: string, contentHash: string, messages: StoredMessage[]): void {
    const tx = this.db.transaction(() => {
      // Insert/update global cache with message IDs
      const cacheStmt = this.db.prepare(`
        INSERT OR REPLACE INTO global_summary_cache
          (content_hash, overview, intent, actions_json, artifacts_json,
           outcome, errors_json, todos_json, confidence, reason, generated_at, 
           tokens_used, last_hit_at, start_msg_id, end_msg_id)
        VALUES
          (@content_hash, @overview, @intent, @actions_json, @artifacts_json,
           @outcome, @errors_json, @todos_json, @confidence, @reason, @generated_at,
           @tokens_used, @last_hit_at, @start_msg_id, @end_msg_id)
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
        start_msg_id: summary.startMsgId,
        end_msg_id: summary.endMsgId,
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

      // Insert messages
      const msgStmt = this.db.prepare(`
        INSERT OR REPLACE INTO turn_messages
          (msg_id, session_id, turn_index, role, content, tool_calls, created_at, seq_in_turn)
        VALUES
          (@msg_id, @session_id, @turn_index, @role, @content, @tool_calls, @created_at, @seq_in_turn)
      `)

      for (const msg of messages) {
        msgStmt.run({
          msg_id: msg.msgId,
          session_id: msg.sessionId,
          turn_index: msg.turnIndex,
          role: msg.role,
          content: msg.content,
          tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          created_at: msg.createdAt,
          seq_in_turn: msg.seqInTurn,
        })
      }
    })

    tx()
  }

  /**
   * Get messages for a turn by session and turn index.
   */
  getMessages(sessionId: string, turnIndex: number): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM turn_messages
      WHERE session_id = ? AND turn_index = ?
      ORDER BY seq_in_turn ASC
    `)
    
    return (stmt.all(sessionId, turnIndex) as any[]).map((row) => this.rowToMessage(row))
  }

  /**
   * Get messages by range (msgId).
   */
  getMessagesByRange(startMsgId: string, endMsgId: string): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM turn_messages
      WHERE msg_id >= ? AND msg_id <= ?
      ORDER BY seq_in_turn ASC
    `)
    
    return (stmt.all(startMsgId, endMsgId) as any[]).map((row) => this.rowToMessage(row))
  }

  /**
   * Batch insert summaries with messages (for efficiency).
   */
  insertBatch(
    summaries: Array<{ summary: TurnSummary; sessionId: string; contentHash: string; messages: StoredMessage[] }>
  ): void {
    const tx = this.db.transaction(() => {
      const cacheStmt = this.db.prepare(`
        INSERT OR REPLACE INTO global_summary_cache
          (content_hash, overview, intent, actions_json, artifacts_json,
           outcome, errors_json, todos_json, confidence, reason, generated_at,
           tokens_used, last_hit_at, start_msg_id, end_msg_id)
        VALUES
          (@content_hash, @overview, @intent, @actions_json, @artifacts_json,
           @outcome, @errors_json, @todos_json, @confidence, @reason, @generated_at,
           @tokens_used, @last_hit_at, @start_msg_id, @end_msg_id)
      `)

      const idxStmt = this.db.prepare(`
        INSERT OR REPLACE INTO session_turn_summaries
          (session_id, turn_index, content_hash)
        VALUES
          (@session_id, @turn_index, @content_hash)
      `)

      const msgStmt = this.db.prepare(`
        INSERT OR REPLACE INTO turn_messages
          (msg_id, session_id, turn_index, role, content, tool_calls, created_at, seq_in_turn)
        VALUES
          (@msg_id, @session_id, @turn_index, @role, @content, @tool_calls, @created_at, @seq_in_turn)
      `)

      for (const { summary, sessionId, contentHash, messages } of summaries) {
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
          start_msg_id: summary.startMsgId,
          end_msg_id: summary.endMsgId,
        })

        idxStmt.run({
          session_id: sessionId,
          turn_index: summary.turnIndex,
          content_hash: contentHash,
        })

        for (const msg of messages) {
          msgStmt.run({
            msg_id: msg.msgId,
            session_id: msg.sessionId,
            turn_index: msg.turnIndex,
            role: msg.role,
            content: msg.content,
            tool_calls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
            created_at: msg.createdAt,
            seq_in_turn: msg.seqInTurn,
          })
        }
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
   * Search summaries by content (FTS).
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

  /**
   * Search messages by content (FTS).
   */
  searchMessages(query: string, sessionId?: string, limit = 10): StoredMessage[] {
    if (!query.trim()) return []

    const escaped = query.replace(/['"*()\-:^~]/g, " ")
    const ftsQuery = escaped.trim().split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '""')}"`).join(" ")

    let stmt: any
    try {
      if (sessionId) {
        stmt = this.db.prepare(`
          SELECT m.* FROM turn_messages m
          JOIN messages_fts f ON m.rowid = f.rowid
          WHERE f.session_id = ? AND f.messages_fts MATCH ?
          ORDER BY m.session_id, m.turn_index, m.seq_in_turn
          LIMIT ?
        `)
        return (stmt.all(sessionId, ftsQuery, limit) as any[]).map((row) => this.rowToMessage(row))
      } else {
        stmt = this.db.prepare(`
          SELECT m.* FROM turn_messages m
          JOIN messages_fts f ON m.rowid = f.rowid
          WHERE f.messages_fts MATCH ?
          ORDER BY m.session_id, m.turn_index, m.seq_in_turn
          LIMIT ?
        `)
        return (stmt.all(ftsQuery, limit) as any[]).map((row) => this.rowToMessage(row))
      }
    } catch {
      return []
    }
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
      startMsgId: row.start_msg_id,
      endMsgId: row.end_msg_id,
    }
  }

  private rowToMessage(row: any): StoredMessage {
    return {
      msgId: row.msg_id,
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      role: row.role as "user" | "assistant" | "tool",
      content: row.content,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      createdAt: row.created_at,
      seqInTurn: row.seq_in_turn,
    }
  }

  deleteSession(sessionId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM turn_messages WHERE session_id = ?").run(sessionId)
      this.db.prepare("DELETE FROM session_turn_summaries WHERE session_id = ?").run(sessionId)
    })
    tx()
  }

  /**
   * Get cache statistics.
   */
  getStats(): { totalCacheEntries: number; totalHits: number; totalMessages: number } {
    const row = this.db.prepare(
      "SELECT COUNT(*) as totalCacheEntries, COALESCE(SUM(hit_count), 0) as totalHits FROM global_summary_cache"
    ).get() as any
    const msgRow = this.db.prepare(
      "SELECT COUNT(*) as totalMessages FROM turn_messages"
    ).get() as any
    return { 
      totalCacheEntries: row.totalCacheEntries, 
      totalHits: row.totalHits,
      totalMessages: msgRow.totalMessages,
    }
  }

  close(): void {
    this.db.close()
  }
}
