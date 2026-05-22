/**
 * Database base for ctx_plugin MCP server.
 *
 * Provides SQLite infrastructure using Node.js built-in sqlite module.
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
 * SQLite database wrapper with WAL mode and retry logic.
 */
export class Database {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#init();
  }

  #init(): void {
    // Enable WAL mode for better concurrent access
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=NORMAL");
    this.#db.exec("PRAGMA cache_size=-64000"); // 64MB cache
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
      get: (...params: unknown[]) => stmt.get(...(params as Parameters<typeof stmt.get>)),
      all: (...params: unknown[]) => stmt.all(...(params as Parameters<typeof stmt.all>)),
    };
  }

  transaction<T>(fn: () => T): T {
    // Use exec with BEGIN/COMMIT for transaction
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
 * Open or create a database at the given path.
 */
export function openDatabase(path: string): Database {
  return new Database(path);
}

/**
 * Close a database connection.
 */
export function closeDatabase(db: Database): void {
  db.close();
}
