/**
 * Unified SQLite database wrapper for Context Forge.
 *
 * Single source of truth — all components (MCP servers, plugins)
 * use this class instead of raw node:sqlite or better-sqlite3.
 *
 * Features:
 *   - WAL mode + NORMAL synchronous for concurrent read/write safety
 *   - Prepared statement wrapper with consistent return types
 *   - Transaction helper with auto-rollback
 */

import { DatabaseSync } from "node:sqlite";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * SQLite database wrapper with WAL mode and standard pragmas.
 *
 * Usage:
 *   const db = new Database("/path/to/data.db");
 *   const row = db.prepare("SELECT * FROM t WHERE id = ?").get(1);
 *   db.close();
 */
export class Database {
  #db: DatabaseSync;

  constructor(path: string, opts?: { readonly?: boolean }) {
    this.#db = new DatabaseSync(path, { open: !opts?.readonly });
    this.#init();
  }

  #init(): void {
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=NORMAL");
    this.#db.exec("PRAGMA cache_size=-64000");
    this.#db.exec("PRAGMA temp_store=MEMORY");
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.#db.prepare(sql);
    return {
      run: (...params: unknown[]) => {
        const result = stmt.run(...(params as Parameters<typeof stmt.run>));
        return {
          changes: Number(result.changes),
          lastInsertRowid: Number(result.lastInsertRowid),
        };
      },
      get: (...params: unknown[]) =>
        stmt.get(...(params as Parameters<typeof stmt.get>)),
      all: (...params: unknown[]) =>
        stmt.all(...(params as Parameters<typeof stmt.all>)),
    };
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN TRANSACTION");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    this.#db.close();
  }

  get raw(): DatabaseSync {
    return this.#db;
  }
}

/**
 * Convenience — open a read-write database.
 */
export function openDatabase(path: string): Database {
  return new Database(path);
}

/**
 * Convenience — open a read-only database.
 */
export function openReadonlyDatabase(path: string): Database {
  return new Database(path, { readonly: true });
}
