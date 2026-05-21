#!/usr/bin/env node
/**
 * ctx_plugin — caveman-stats CLI
 *
 * Reads from two sources:
 *   1. ~/.local/share/opencode/opencode.db  (SQLite) — all opencode sessions
 *   2. ~/.config/caveman/.caveman-history.jsonl — legacy JSONL history
 *
 * Savings are estimated only for sessions where a .caveman-active flag
 * is present, using a 65% compression ratio benchmark.
 *
 * Usage:
 *   ctx_plugin stats              — show all-time stats
 *   ctx_plugin stats --all        — same as bare
 *   ctx_plugin stats --since 7d   — last 7 days
 *   ctx_plugin stats --since 24h  — last 24 hours
 *   ctx_plugin stats --share      — one-line summary
 */

import * as fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Pricing (USD per million output tokens)
// ---------------------------------------------------------------------------

const MODEL_OUTPUT_PRICE_PER_M = [
  ["claude-opus-4", 75.0],
  ["claude-sonnet-4", 15.0],
  ["claude-haiku-4", 4.0],
  ["claude-3-5-sonnet", 15.0],
  ["claude-3-5-haiku", 4.0],
  ["claude-3-opus", 75.0],
  ["claude-haiku-4-20250514", 4.0],
  ["vllm/GLM-4.7", 0.1],    // GLM-4 (self-hosted / 9router)
  ["vllm/GLM-Z1-32B", 0.1],
  ["deepseek-v4-flash-free", 0.0],
  ["bitfun/deepseek-v4-pro", 0.0],
]

function priceForModel(model) {
  if (!model) return null
  for (const [prefix, price] of MODEL_OUTPUT_PRICE_PER_M) {
    if (model.startsWith(prefix)) return price
  }
  return null
}

function extractModelId(modelJson) {
  if (!modelJson) return null
  if (typeof modelJson === "string") return modelJson
  if (typeof modelJson === "object" && modelJson.id) return modelJson.id
  return null
}

function formatUsd(amount) {
  if (!Number.isFinite(amount)) return "$0.00"
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount >= 0.01) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(4)}`
}

function humanizeTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
  return String(Math.round(n))
}

function parseDuration(spec) {
  const m = /^(\d+)([dh])$/.exec(spec.trim())
  if (!m) return null
  const n = parseInt(m[1], 10)
  return m[2] === "d" ? n * 86_400_000 : n * 3_600_000
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function opencodeDataDir() {
  if (process.env.OPENCODE_DATA_DIR) return process.env.OPENCODE_DATA_DIR
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "opencode")
  }
  return path.join(os.homedir(), ".local", "share", "opencode")
}

function cavemanDir() {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "caveman")
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "caveman")
  }
  return path.join(os.homedir(), ".config", "caveman")
}

const HISTORY_FILE = path.join(cavemanDir(), ".caveman-history.jsonl")
const CAVEMAN_ACTIVE_FLAG = path.join(opencodeDataDir(), ".caveman-active")

// ---------------------------------------------------------------------------
// SQLite (opencode) reader
// ---------------------------------------------------------------------------

// Use the built-in sqlite3 binary for broad compatibility.
// Falls back gracefully if sqlite3 is not available.
async function opencodeSessionRows(sinceMs) {
  try {
    const dbPath = path.join(opencodeDataDir(), "opencode.db")
    if (!fs.existsSync(dbPath)) return null

    let sql = "SELECT id, title, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost, model, agent, directory, time_created, time_updated FROM session WHERE tokens_output > 0"
    if (sinceMs) {
      sql += ` AND time_created >= ${sinceMs}`
    }

    // Require the sqlite3 CLI (available on macOS/Linux by default)
    const { execSync } = await import("node:child_process")
    const escapedDb = dbPath.replace(/"/g, '""')
    const escapedSql = sql.replace(/"/g, '""')
    const rows = execSync(`sqlite3 "${escapedDb}" "${escapedSql}"`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim()

    if (!rows) return []

    return rows.split("\n").map(line => {
      const [id, title, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost, model, agent, directory, time_created, time_updated] = line.split("|")
      return {
        id: id || "",
        title: title || "",
        tokens_input: parseInt(tokens_input, 10) || 0,
        tokens_output: parseInt(tokens_output, 10) || 0,
        tokens_cache_read: parseInt(tokens_cache_read, 10) || 0,
        tokens_cache_write: parseInt(tokens_cache_write, 10) || 0,
        cost: parseFloat(cost) || 0,
        model,
        agent: agent || "",
        directory: directory || "",
        time_created: parseInt(time_created, 10) || 0,
        time_updated: parseInt(time_updated, 10) || 0,
      }
    })
  } catch {
    return null  // sqlite3 not available or query failed
  }
}

// ---------------------------------------------------------------------------
// Caveman-active detection
// ---------------------------------------------------------------------------

function isCavemanActive() {
  try {
    const st = fs.lstatSync(CAVEMAN_ACTIVE_FLAG)
    if (!st.isFile() || st.size > 64) return false
    const raw = fs.readFileSync(CAVEMAN_ACTIVE_FLAG, "utf8").trim().toLowerCase()
    return raw.length > 0 && raw !== "off"
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// JSONL reader (legacy caveman history)
// ---------------------------------------------------------------------------

function readHistory() {
  try {
    const st = fs.lstatSync(HISTORY_FILE)
    if (st.isSymbolicLink() || !st.isFile()) return []
  } catch {
    return []
  }
  try {
    return fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(l => l.trim())
  } catch {
    return []
  }
}

function aggregateHistory(sinceMs) {
  const lines = readHistory()
  const cutoff = sinceMs ? Date.now() - sinceMs : null
  const latestPerSession = new Map()

  for (const line of lines) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== "object") continue
    if (cutoff !== null && (entry.ts || 0) < cutoff) continue
    const id = entry.session_id || "_"
    const prev = latestPerSession.get(id)
    if (!prev || (entry.ts || 0) >= (prev.ts || 0)) {
      latestPerSession.set(id, entry)
    }
  }

  let outputTokens = 0, estSavedTokens = 0, estSavedUsd = 0
  for (const e of latestPerSession.values()) {
    outputTokens   += e.output_tokens     || 0
    estSavedTokens += e.est_saved_tokens || 0
    estSavedUsd    += e.est_saved_usd    || 0
  }

  return { sessions: latestPerSession.size, outputTokens, estSavedTokens, estSavedUsd }
}

// ---------------------------------------------------------------------------
// Combined aggregator
// ---------------------------------------------------------------------------

const COMPRESSION_RATIO = 0.65  // full-mode benchmark savings

async function aggregateAll(sinceMs) {
  const [jsonlAgg, rows] = await Promise.all([
    Promise.resolve(aggregateHistory(sinceMs)),
    opencodeSessionRows(sinceMs),
  ])

  let outputTokens = 0, estSavedTokens = 0, estSavedUsd = 0
  let opencodeSessions = 0

  // Dedup: collect all JSONL session IDs so we don't double-count
  const jsonlLines = readHistory()
  const cutoff = sinceMs ? Date.now() - sinceMs : null
  const jsonlSessionIds = new Set()
  for (const line of jsonlLines) {
    try {
      const e = JSON.parse(line)
      if (!e || typeof e !== "object") continue
      if (cutoff !== null && (e.ts || 0) < cutoff) continue
      if (e.session_id) jsonlSessionIds.add(e.session_id)
    } catch {}
  }

  // Aggregate opencode sessions not already in JSONL
  const isCaveman = isCavemanActive()
  if (rows !== null) {
    for (const r of rows) {
      if (jsonlSessionIds.has(r.id)) continue  // already counted via JSONL
      opencodeSessions++
      outputTokens += r.tokens_output

      if (isCaveman) {
        const modelId = extractModelId(r.model)
        const price = priceForModel(modelId)
        const estNormal = Math.round(r.tokens_output / (1 - COMPRESSION_RATIO))
        const saved = estNormal - r.tokens_output
        estSavedTokens += saved
        if (price !== null && price > 0) {
          estSavedUsd += (saved / 1_000_000) * price
        }
      }
    }
  }

  return {
    sessions: jsonlAgg.sessions + opencodeSessions,
    outputTokens: jsonlAgg.outputTokens + outputTokens,
    estSavedTokens: jsonlAgg.estSavedTokens + estSavedTokens,
    estSavedUsd: jsonlAgg.estSavedUsd + estSavedUsd,
    opencodeSessions,
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatHistory(agg, since) {
  const sep = "──────────────────────────────────"
  const window = since ? ` (last ${since})` : ""

  if (agg.sessions === 0) {
    return (
      `\nCaveman Stats — Lifetime${window}\n${sep}\n` +
      `No sessions logged yet — stats accumulate when /caveman-stats\n` +
      `runs inside a Claude Code session, or when opencode sessions are\n` +
      `tracked with an active .caveman-active flag.\n${sep}\n` +
      `opencode DB: ${path.join(opencodeDataDir(), "opencode.db")}\n` +
      `JSONL hist: ${HISTORY_FILE}\n`
    )
  }

  const usdLine = agg.estSavedUsd > 0
    ? `Est. saved (USD):      ~${formatUsd(agg.estSavedUsd)}\n`
    : ""

  return (
    `\nCaveman Stats — Lifetime${window}\n${sep}\n` +
    `Sessions:             ${agg.sessions.toLocaleString()}\n` +
    `  opencode (SQLite):   ${agg.opencodeSessions || 0}\n${sep}\n` +
    `Output tokens:        ${agg.outputTokens.toLocaleString()}\n` +
    `Est. tokens saved:    ${agg.estSavedTokens.toLocaleString()}\n` +
    usdLine +
    `${sep}\n` +
    `opencode DB: ${path.join(opencodeDataDir(), "opencode.db")}\n` +
    `JSONL hist:  ${HISTORY_FILE}\n`
  )
}

function formatShare(agg) {
  if (agg.sessions === 0) {
    return "🪨 no sessions logged yet — ctx_plugin"
  }
  const avgPerSession = agg.outputTokens / agg.sessions
  const tokensPerSession = Math.round(avgPerSession)
  return (
    `🪨 ${agg.sessions} sessions, ~${tokensPerSession.toLocaleString()} avg output tokens/session, ` +
    `~${agg.estSavedTokens.toLocaleString()} total est. saved — ctx_plugin`
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const share = args.includes("--share")
  const all   = args.includes("--all")
  const sinceIdx = args.indexOf("--since")
  const sinceArg  = sinceIdx !== -1 ? args[sinceIdx + 1] : null

  if (sinceArg !== null && parseDuration(sinceArg) === null) {
    process.stderr.write(
      `ctx_plugin stats: --since takes Nh or Nd (e.g. 7d, 24h), got: ${sinceArg}\n`
    )
    process.exit(2)
  }

  const sinceMs = sinceArg ? parseDuration(sinceArg) : undefined
  const agg = await aggregateAll(sinceMs)

  if (share) {
    process.stdout.write(formatShare(agg) + "\n")
  } else {
    process.stdout.write(formatHistory(agg, sinceArg || undefined))
  }
}

main().catch(err => {
  process.stderr.write(`ctx_plugin stats: ${err.message}\n`)
  process.exit(1)
})
