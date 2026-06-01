/**
 * db-base — SQLite infrastructure for transform plugin.
 *
 * Uses node:sqlite (built into Node.js 22.5+) — no external dependencies.
 * FTS5 is fully supported.
 *
 * Key differences from better-sqlite3 / sql.js:
 * - Synchronous API (no WASM loading, no async)
 * - DatabaseSync for thread-safe access
 * - .exec() for multi-statement, .prepare() for statements
 * - FTS5 and WAL mode work out of the box
 */

import { existsSync, unlinkSync, renameSync } from "node:fs"
import { dirname } from "node:path"

// ─────────────────────────────────────────────────────────
// Corruption detection & recovery
// ─────────────────────────────────────────────────────────

export function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  )
}

export function renameCorruptDB(dbPath: string): void {
  const ts = Date.now()
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`)
    } catch {
      /* file may not exist */
    }
  }
}

export function cleanOrphanedWALFiles(dbPath: string): void {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix)
      } catch {
        /* ignore */
      }
    }
  }
}

// ─────────────────────────────────────────────────────────
// WAL + FTS5 mmap setup
// ─────────────────────────────────────────────────────────

export function applyWALPragmas(db: any): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  try {
    db.exec("PRAGMA mmap_size = 268435456")
  } catch {
    /* unsupported */
  }
}

// ─────────────────────────────────────────────────────────
// Safe DB open with corruption recovery
// ─────────────────────────────────────────────────────────

export function openDatabase(dbPath: string): any {
  cleanOrphanedWALFiles(dbPath)
  const { DatabaseSync } = require("node:sqlite")

  let db: any
  try {
    db = new DatabaseSync(dbPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (isSQLiteCorruptionError(msg)) {
      renameCorruptDB(dbPath)
      cleanOrphanedWALFiles(dbPath)
      db = new DatabaseSync(dbPath)
    } else {
      throw err
    }
  }

  applyWALPragmas(db)
  return db
}

// ─────────────────────────────────────────────────────────
// Live DB registry (prevents GC issues on process exit)
// ─────────────────────────────────────────────────────────

const _liveDBs = new Set<any>()
process.on("exit", () => {
  for (const db of _liveDBs) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
    } catch {
      /* WAL may not be active */
    }
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
  _liveDBs.clear()
})

export function registerDB(db: any): void {
  _liveDBs.add(db)
}

export function unregisterDB(db: any): void {
  _liveDBs.delete(db)
}
