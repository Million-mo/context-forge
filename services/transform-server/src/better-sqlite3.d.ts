declare module "better-sqlite3" {
  function Database(filename?: string | Buffer): BetterSqlite3.Database
  namespace BetterSqlite3 {
    class Database {
      exec(sql: string): void
      prepare(sql: string): Statement
      close(): void
    }
    class Statement {
      run(...params: any[]): RunResult
      get(...params: any[]): any
      all(...params: any[]): any[]
    }
    interface RunResult {
      changes: number
      lastInsertRowid: number | bigint
    }
  }
  export = Database
}
