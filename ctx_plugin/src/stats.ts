/**
 * ctx_plugin — caveman-stats module
 *
 * Tracks token usage and estimates savings from caveman compression mode.
 * Integrates with the opencode plugin lifecycle.
 *
 * Based on caveman/src/hooks/caveman-stats.js
 */

import * as fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Mean per-task savings from benchmarks (full mode: 65% reduction)
const COMPRESSION: Record<string, number> = {
  "full": 0.65,
}

// Approximate output-token pricing, USD per million
const MODEL_OUTPUT_PRICE_PER_M: [string, number][] = [
  ["claude-opus-4", 75.0],
  ["claude-sonnet-4", 15.0],
  ["claude-haiku-4", 4.0],
  ["claude-3-5-sonnet", 15.0],
  ["claude-3-5-haiku", 4.0],
  ["claude-3-opus", 75.0],
]

function priceForModel(model: string | null): number | null {
  if (!model) return null
  for (const [prefix, price] of MODEL_OUTPUT_PRICE_PER_M) {
    if (model.startsWith(prefix)) return price
  }
  return null
}

function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`
  if (amount >= 0.01) return `$${amount.toFixed(3)}`
  return `$${amount.toFixed(4)}`
}

function humanizeTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k"
  return String(Math.round(n))
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function opencodeDir(): string {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "opencode")
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "opencode",
    )
  }
  return path.join(os.homedir(), ".config", "opencode")
}

function cavemanDir(): string {
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, "caveman")
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "caveman")
  }
  return path.join(os.homedir(), ".config", "caveman")
}

const HISTORY_FILE = path.join(cavemanDir(), ".caveman-history.jsonl")
const CAVEMAN_FLAG = path.join(opencodeDir(), ".caveman-active")

// ---------------------------------------------------------------------------
// File I/O (symlink-safe)
// ---------------------------------------------------------------------------

function appendHistory(entry: string): void {
  try {
    const dir = path.dirname(HISTORY_FILE)
    fs.mkdirSync(dir, { recursive: true })

    const realDir = resolveRealDir(dir)
    if (!realDir) return

    const realPath = path.join(realDir, path.basename(HISTORY_FILE))
    if (isSymlink(realPath)) return

    const line = entry.replace(/\n$/, "") + "\n"
    fs.appendFileSync(realPath, line, { encoding: "utf8", mode: 0o600 })
  } catch {}
}

function readHistory(): string[] {
  try {
    if (isSymlink(HISTORY_FILE) || !fs.existsSync(HISTORY_FILE)) return []
    return fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(l => l.trim())
  } catch {
    return []
  }
}

function resolveRealDir(dir: string): string | null {
  try {
    const st = fs.lstatSync(dir)
    if (st.isSymbolicLink()) {
      const realDir = fs.realpathSync(dir)
      const realSt = fs.statSync(realDir)
      if (!realSt.isDirectory()) return null
      if (typeof process.getuid === "function" && realSt.uid !== process.getuid()) return null
      return realDir
    }
    return dir
  } catch {
    return null
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

function readFlag(): string | null {
  try {
    const st = fs.lstatSync(CAVEMAN_FLAG)
    if (st.isSymbolicLink() || !st.isFile()) return null
    if (st.size > 64) return null
    const raw = fs.readFileSync(CAVEMAN_FLAG, "utf8").trim().toLowerCase()
    const validModes = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-full", "wenyan-ultra", "commit", "review", "compress"]
    return validModes.includes(raw) ? raw : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

interface SessionStats {
  outputTokens: number
  cacheReadTokens: number
  turns: number
  model: string | null
}

interface SavingsResult {
  estSavedTokens: number
  estSavedUsd: number
}

function deriveSavings(stats: SessionStats, mode: string | null): SavingsResult {
  const ratio = mode && COMPRESSION[mode] !== undefined ? COMPRESSION[mode] : null
  const price = priceForModel(stats.model)
  if (ratio === null) return { estSavedTokens: 0, estSavedUsd: 0 }
  const estNormal = Math.round(stats.outputTokens / (1 - ratio))
  const estSavedTokens = estNormal - stats.outputTokens
  const estSavedUsd = price !== null ? (estSavedTokens / 1_000_000) * price : 0
  return { estSavedTokens, estSavedUsd }
}

interface AggregatedStats {
  sessions: number
  outputTokens: number
  estSavedTokens: number
  estSavedUsd: number
}

function aggregateHistory(sinceMs?: number): AggregatedStats {
  const lines = readHistory()
  const cutoff = sinceMs ? Date.now() - sinceMs : null
  const latestPerSession = new Map<string, object>()

  for (const line of lines) {
    let entry: { ts?: number; session_id?: string; output_tokens?: number; est_saved_tokens?: number; est_saved_usd?: number }
    try { entry = JSON.parse(line) } catch { continue }
    if (!entry || typeof entry !== "object") continue
    if (cutoff !== null && (entry.ts || 0) < cutoff) continue
    const id = entry.session_id || "_"
    const prev = latestPerSession.get(id)
    if (!prev || (entry.ts || 0) >= ((prev as { ts?: number }).ts || 0)) {
      latestPerSession.set(id, entry)
    }
  }

  let outputTokens = 0, estSavedTokens = 0, estSavedUsd = 0
  for (const e of latestPerSession.values()) {
    const entry = e as { output_tokens?: number; est_saved_tokens?: number; est_saved_usd?: number }
    outputTokens += entry.output_tokens || 0
    estSavedTokens += entry.est_saved_tokens || 0
    estSavedUsd += entry.est_saved_usd || 0
  }

  return { sessions: latestPerSession.size, outputTokens, estSavedTokens, estSavedUsd }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatStats(stats: SessionStats, mode: string | null): string {
  const sep = "──────────────────────────────────"

  if (stats.turns === 0) {
    return `\nCaveman Stats\n${sep}\nNo conversation yet — stats available after first response.\n${sep}\n`
  }

  const ratio = mode && COMPRESSION[mode] !== undefined ? COMPRESSION[mode] : null
  const price = priceForModel(stats.model)

  let savings: string
  let footer = ""

  if (ratio !== null) {
    const estNormal = Math.round(stats.outputTokens / (1 - ratio))
    const estSaved = estNormal - stats.outputTokens
    let usdLine = ""
    if (price !== null) {
      const usd = (estSaved / 1_000_000) * price
      usdLine = `Est. saved (USD):      ~${formatUsd(usd)}\n`
      footer = `Savings est. from benchmarks/ (mean per-task). Pricing for ${stats.model}. Actual varies by task.`
    } else {
      footer = "Savings est. from benchmarks/ (mean per-task). Actual varies by task."
    }
    savings = `Est. without caveman:  ${estNormal.toLocaleString()}\n` +
      `Est. tokens saved:     ${estSaved.toLocaleString()} (~${Math.round(ratio * 100)}%)\n` +
      usdLine.replace(/\n$/, "")
  } else if (mode && mode !== "off") {
    savings = `No savings estimate for '${mode}' mode — only 'full' has benchmark data.`
  } else {
    savings = "Caveman not active this session."
  }

  return `\nCaveman Stats\n${sep}\n` +
    `Turns:    ${stats.turns}\n${sep}\n` +
    `Output tokens:         ${stats.outputTokens.toLocaleString()}\n` +
    `Cache-read tokens:     ${stats.cacheReadTokens.toLocaleString()}\n${sep}\n` +
    `${savings}\n` +
    (footer ? footer + "\n" : "")
}

function formatHistory(agg: AggregatedStats, since?: string): string {
  const sep = "──────────────────────────────────"
  const window = since ? ` (last ${since})` : ""

  if (agg.sessions === 0) {
    return `\nCaveman Stats — Lifetime${window}\n${sep}\nNo sessions logged yet — run /caveman-stats inside any session to start tracking.\n${sep}\n`
  }

  const usdLine = agg.estSavedUsd > 0 ? `Est. saved (USD):      ~${formatUsd(agg.estSavedUsd)}\n` : ""
  return `\nCaveman Stats — Lifetime${window}\n${sep}\n` +
    `Sessions:   ${agg.sessions.toLocaleString()}\n${sep}\n` +
    `Output tokens:         ${agg.outputTokens.toLocaleString()}\n` +
    `Est. tokens saved:     ${agg.estSavedTokens.toLocaleString()}\n` +
    usdLine + sep + "\n"
}

function formatShare(stats: SessionStats, mode: string | null): string {
  if (stats.turns === 0) {
    return "🪨 caveman armed but no turns yet — ctx_plugin"
  }

  const ratio = mode && COMPRESSION[mode] !== undefined ? COMPRESSION[mode] : null
  const price = priceForModel(stats.model)

  if (ratio !== null) {
    const estSaved = Math.round(stats.outputTokens / (1 - ratio)) - stats.outputTokens
    let usd = ""
    if (price !== null) {
      const amt = (estSaved / 1_000_000) * price
      usd = ` (~${formatUsd(amt)})`
    }
    return `🪨 Saved ${estSaved.toLocaleString()} output tokens${usd} across ${stats.turns} turns this session — ctx_plugin`
  }

  return `🪨 ${stats.turns} turns, ${stats.outputTokens.toLocaleString()} output tokens this session — ctx_plugin`
}

// ---------------------------------------------------------------------------
// API for plugin integration
// ---------------------------------------------------------------------------

/**
 * Log current session stats to history file.
 * Called from the plugin on chat events.
 */
export function logSessionStats(stats: SessionStats): void {
  const mode = readFlag()
  const savings = deriveSavings(stats, mode)
  const sessionId = `opencode-${Date.now()}`

  appendHistory(JSON.stringify({
    ts: Date.now(),
    session_id: sessionId,
    mode: mode || null,
    model: stats.model || null,
    output_tokens: stats.outputTokens,
    est_saved_tokens: savings.estSavedTokens,
    est_saved_usd: savings.estSavedUsd,
  }))
}

/**
 * Get formatted stats output for a single session.
 */
export function getSessionStatsOutput(stats: SessionStats, mode: string | null): string {
  return formatStats(stats, mode)
}

/**
 * Get formatted lifetime stats output.
 */
export function getHistoryOutput(since?: string): string {
  const sinceMs = since ? parseDuration(since) : undefined
  const agg = aggregateHistory(sinceMs)
  return formatHistory(agg, since)
}

/**
 * Get shareable one-line summary.
 */
export function getShareOutput(stats: SessionStats, mode: string | null): string {
  return formatShare(stats, mode)
}

/**
 * Parse duration string like "7d" or "24h" to milliseconds.
 */
function parseDuration(spec: string): number | null {
  const m = /^(\d+)([dh])$/.exec(spec.trim())
  if (!m) return null
  const n = parseInt(m[1], 10)
  return m[2] === "d" ? n * 86_400_000 : n * 3_600_000
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export function main(args: string[] = process.argv.slice(2)): void {
  const share = args.includes("--share")
  const all = args.includes("--all")
  const sinceIdx = args.indexOf("--since")
  const sinceArg = sinceIdx !== -1 ? args[sinceIdx + 1] : null

  // Lifetime aggregation
  if (all || sinceArg) {
    if (sinceArg && parseDuration(sinceArg) === null) {
      process.stderr.write(`ctx_plugin stats: --since takes Nh or Nd (e.g. 7d, 24h), got: ${sinceArg}\n`)
      process.exit(2)
    }
    const sinceMs = sinceArg ? parseDuration(sinceArg)! : undefined
    process.stdout.write(getHistoryOutput(sinceArg || undefined))
    return
  }

  // Current session (no session tracking in opencode yet, show lifetime)
  const agg = aggregateHistory()
  if (share) {
    // For share mode, estimate from aggregated lifetime
    const totalTurns = agg.outputTokens > 0 ? Math.ceil(agg.outputTokens / 500) : 0
    const stats: SessionStats = { outputTokens: agg.outputTokens, cacheReadTokens: 0, turns: totalTurns, model: null }
    process.stdout.write(getShareOutput(stats, null) + "\n")
  } else {
    process.stdout.write(getHistoryOutput())
  }
}
