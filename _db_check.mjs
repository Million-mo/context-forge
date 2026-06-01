import initSqlJs from "sql.js";
import { readFileSync } from "fs";

const SQL = await initSqlJs();
const buf = readFileSync(".ctx_plugin/data/content.db");
const db = new SQL.Database(buf);

const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
console.log("Tables:", tables.map((r) => r.values.map((v) => v[0])));

const chunks = db.exec("SELECT COUNT(*) FROM chunks");
const sources = db.exec("SELECT COUNT(*) FROM sources");
const sessions = db.exec(
  "SELECT session_id, event_count, project_dir FROM sessions LIMIT 5"
);

console.log("Chunks:", chunks[0]?.values[0][0]);
console.log("Sources:", sources[0]?.values[0][0]);

if (sessions[0]) {
  sessions[0].values.forEach((r) =>
    console.log("Session:", r[0], r[1] + "events", r[2])
  );
}

db.close();
