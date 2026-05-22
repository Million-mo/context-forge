#!/usr/bin/env node
/**
 * ctx_plugin — gain CLI
 *
 * Reads RTK's tracking database (~/.local/share/rtk/history.db on Linux,
 * ~/Library/Application Support/rtk/history.db on macOS) and presents
 * two dimensions RTK gain does not:
 *   1. Commands grouped by category, ranked by impact (saved tokens)
 *   2. Daily trend table
 *
 * Usage:
 *   ctx_plugin gain           — show all-time summary + categories
 *   ctx_plugin gain --all     — same as bare
 *   ctx_plugin gain --since Nd — last N days
 *   ctx_plugin gain --project <name> — filter by project directory name
 *   ctx_plugin gain --share   — one-line summary
 */

import * as fs from "node:fs"
import path from "node:path"
import os from "node:os"

// ---------------------------------------------------------------------------
// ANSI Color palette
// ---------------------------------------------------------------------------

const C = {
  reset:       "\x1b[0m",
  bold:        "\x1b[1m",
  dim:         "\x1b[2m",
  red:         "\x1b[31m",
  green:       "\x1b[32m",
  yellow:      "\x1b[33m",
  blue:        "\x1b[34m",
  magenta:     "\x1b[35m",
  cyan:        "\x1b[36m",
  white:       "\x1b[37m",
  brightGreen: "\x1b[92m",
  brightCyan:  "\x1b[96m",
  brightWhite: "\x1b[97m",
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function rtkHistoryDb() {
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "rtk", "history.db")
  }
  // macOS uses ~/Library/Application Support/
  const macPath = path.join(os.homedir(), "Library", "Application Support", "rtk", "history.db")
  if (fs.existsSync(macPath)) return macPath
  // Linux fallback
  return path.join(os.homedir(), ".local", "share", "rtk", "history.db")
}

// ---------------------------------------------------------------------------
// SQLite via Python temp script (avoids shell quoting issues)
// ---------------------------------------------------------------------------

async function queryDb(sql) {
  const db = rtkHistoryDb()
  if (!fs.existsSync(db)) return null

  // Write SQL to a temp .py file to avoid shell quoting issues,
  // then execute it. The file is always deleted after use.
  // Use a unique file per call to handle concurrent queries
  const tmp = path.join(os.tmpdir(), `ctx_plugin_q_${Date.now()}_${Math.random().toString(36).slice(2)}.py`)
  const script = [
    `import sqlite3, json, sys`,
    `conn = sqlite3.connect('${db.replace(/'/g, "\\'")}')`,
    `conn.row_factory = sqlite3.Row`,
    `cur = conn.cursor()`,
    `cur.execute(${JSON.stringify(sql)})`,
    `rows = [dict(r) for r in cur.fetchall()]`,
    `print(json.dumps(rows))`,
    `conn.close()`,
  ].join("\n")

  try {
    fs.writeFileSync(tmp, script, "utf8")
    const { execSync } = await import("node:child_process")
    const raw = execSync(`python3 "${tmp}"`, { encoding: "utf8", timeout: 10_000 })
    return JSON.parse(raw.trim() || "[]")
  } catch (err) {
    return null
  }
  // Intentionally not deleting the temp file — OS cleans /tmp periodically.
}

// ---------------------------------------------------------------------------
// Category classifier
// ---------------------------------------------------------------------------

function classify(cmd) {
  const c = (cmd || "").trim()
  if (/^git\s+(diff|log|show|branch|status|fetch|pull|push|stash|tag|rev-parse)/.test(c))
    return "git"
  if (/^git\s+(commit|merge|rebase|cherry-pick)/.test(c)) return "git-commit"
  if (/^git\s+[a-z]/.test(c)) return "git-other"
  if (/^ls/.test(c)) return "ls"
  if (/^grep|^rg|^ag/.test(c)) return "grep"
  if (/^docker|^docker-compose/.test(c)) return "docker"
  if (/^kubectl/.test(c)) return "kubectl"
  if (/^npm|^pnpm|^yarn|^uv/.test(c)) return "package"
  if (/^cat|^head|^tail|^wc|^sort|^uniq|^cut/.test(c)) return "text"
  if (/^find/.test(c)) return "find"
  if (/^aws/.test(c)) return "aws"
  if (/^gh|^glab/.test(c)) return "vcs-cli"
  if (/^psql/.test(c)) return "psql"
  if (/^tree/.test(c)) return "tree"
  if (/^curl|^wget/.test(c)) return "net"
  if (/^make|^cargo|^go|^gradle/.test(c)) return "build"
  return "other"
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

async function aggregateAll({ sinceDays, project, today = false } = {}) {
  const sinceMs = sinceDays ? Date.now() - sinceDays * 86_400_000 : null

  const sinceFilter = sinceMs
    ? `AND timestamp >= datetime('${new Date(sinceMs).toISOString()}')`
    : ""

  const projFilterCmds = project
    ? `AND project_path LIKE '%${project.replace(/'/g, "''")}%'`
    : ""

  const commands = await queryDb(
    `SELECT timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, project_path
     FROM commands
     WHERE saved_tokens > 0 ${sinceFilter} ${projFilterCmds}`
  )

  // Full command list for --today (all, not just saved > 0)
  // date(timestamp) strips the offset so +00:00 timestamps match date('now') correctly
  const todaySql = today
    ? `SELECT timestamp, original_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, project_path
         FROM commands
         WHERE date(timestamp) = date('now')
         ORDER BY timestamp DESC`
    : null

  // Today's failures
  const todayFailSql = today
    ? `SELECT timestamp, raw_command, error_message
         FROM parse_failures
         WHERE date(timestamp) = date('now')`
    : null

  // parse_failures has no project_path — no project filter possible
  // Execute sequentially to avoid race conditions on temp file names
  let failures, todayCmds, todayFails

  if (sinceMs) {
    failures = await queryDb(
      `SELECT timestamp, raw_command, error_message
         FROM parse_failures
         WHERE 1=1 ${sinceFilter}`
    )
  } else {
    failures = await queryDb(
      `SELECT timestamp, raw_command, error_message
         FROM parse_failures`
    )
  }

  if (todaySql) {
    todayCmds = await queryDb(todaySql)
    todayFails = await queryDb(todayFailSql)
  }

  if (!commands) return null

  const cmds  = (commands || [])
  const fails = (failures || [])

  // Overall
  const totalCmds = cmds.length
  const totalInput = cmds.reduce((s, r) => s + (r.input_tokens || 0), 0)
  const totalOutput = cmds.reduce((s, r) => s + (r.output_tokens || 0), 0)
  const totalSaved = cmds.reduce((s, r) => s + (r.saved_tokens || 0), 0)
  const avgPct = totalOutput > 0 ? (totalSaved / totalInput) * 100 : 0

  // By category
  const cats = {}
  for (const r of cmds) {
    const cat = classify(r.original_cmd)
    if (!cats[cat]) cats[cat] = { saved: 0, input: 0, count: 0 }
    cats[cat].saved  += r.saved_tokens  || 0
    cats[cat].input  += r.input_tokens  || 0
    cats[cat].count  += 1
  }
  const byCat = Object.entries(cats)
    .map(([name, d]) => ({
      name,
      saved: d.saved,
      pct: d.input > 0 ? (d.saved / d.input) * 100 : 0,
      count: d.count,
    }))
    .sort((a, b) => b.saved - a.saved)

  // Daily trend (last 7 active days)
  const days = {}
  for (const r of cmds) {
    const day = (r.timestamp || "").slice(0, 10)
    if (!days[day]) days[day] = { saved: 0, count: 0 }
    days[day].saved += r.saved_tokens || 0
    days[day].count += 1
  }
  const byDay = Object.entries(days)
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 7)
    .map(([day, d]) => ({ day, saved: d.saved, count: d.count }))

  return {
    totalCmds, totalInput, totalOutput, totalSaved, avgPct,
    byCat, byDay,
    fails,
    failCount: fails.length,
    failRate: totalCmds + fails.length > 0
      ? (fails.length / (totalCmds + fails.length)) * 100
      : 0,
    todayCmds: todayCmds || null,
    todayFails: todayFails || null,
  }
}

// ---------------------------------------------------------------------------
// Bar renderer (color-coded)
// ---------------------------------------------------------------------------

// Color grades: low → high savings
function barColor(pct) {
  if (pct >= 80) return C.brightGreen
  if (pct >= 60) return C.green
  if (pct >= 40) return C.yellow
  if (pct >= 20) return C.red
  return C.dim
}

function bar(n, max, width = 20, pct = 0) {
  const filled = max > 0 ? Math.round((n / max) * width) : 0
  const col = barColor(pct)
  return col + "█".repeat(filled) + C.dim + "░".repeat(width - filled) + C.reset
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(Math.round(n))
}

function fmtNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

function pad(s, n) {
  return String(s).padStart(n)
}

function formatRow({ name, saved, pct, count }, maxSaved, catWidth) {
  const label = pad(name, catWidth)
  const savedStr = pad(fmtNum(saved), 9)
  const pctStr = `${pct.toFixed(1)}%`.padStart(7)
  const b = bar(saved, maxSaved, 18, pct)
  return (
    `  ${C.cyan}${label}${C.reset}` +
    `  ${C.brightGreen}${savedStr}${C.reset} saved` +
    `  ${C.brightCyan}${pctStr}${C.reset}` +
    `  ${b}` +
    `  ${C.dim}(${count})${C.reset}`
  )
}

function formatDayRow({ day, saved, count }, maxSaved, avgPct) {
  const b = bar(saved, maxSaved, 20, avgPct)
  return (
    `  ${C.blue}${day}${C.reset}` +
    `  ${b}` +
    `  ${C.brightWhite}${pad(count, 4)}cmds${C.reset}` +
    `  ${C.brightGreen}${fmtNum(saved).padStart(9)}${C.reset} saved`
  )
}

function formatGain(agg, { sinceDays, project, share }) {
  if (!agg) {
    return `${C.red}RTK gain — no data found${C.reset}\n  DB: ${rtkHistoryDb()}\n`
  }

  const { totalCmds, totalSaved, avgPct, byCat, byDay, fails, failCount, failRate } = agg

  if (totalCmds === 0) {
    return `${C.yellow}RTK gain — no commands tracked yet${C.reset}\n  Run some commands through opencode with RTK enabled.\n`
  }

  const catWidth = Math.max(12, ...byCat.map(c => c.name.length))
  const maxSaved = byCat[0]?.saved || 1

  const header = []
  if (project) header.push(`  ${C.dim}project:${C.reset} ${C.white}${project}${C.reset}`)
  if (sinceDays) header.push(`  ${C.dim}since:${C.reset} ${C.white}${sinceDays}d${C.reset}`)
  if (header.length) header.unshift("")

  const failLines = fails.slice(0, 5).map(f => {
    const short = (f.raw_command || "").slice(0, 48)
    return `  ${C.red}✗${C.reset} ${short.padEnd(48)} ${C.dim}parse failure${C.reset}`
  })
  if (failCount > 5) failLines.push(`  ${C.dim}… and ${failCount - 5} more${C.reset}`)

  const divider = `${C.dim}${"─".repeat(60)}${C.reset}`

  return [
    `\n${C.bold}${C.brightGreen}RTK gain${C.reset}`,
    divider,
    ...header,
    `  ${C.white}${totalCmds}${C.reset} commands` +
    `  ·  ${C.brightGreen}${fmtNum(totalSaved)}${C.reset} tokens saved` +
    `  ·  ${C.brightCyan}${avgPct.toFixed(1)}%${C.reset} avg` +
    (failCount > 0
      ? `\n  ${C.yellow}${failCount}${C.reset} failures (${C.red}${failRate.toFixed(0)}%${C.reset} failure rate)\n`
      : "\n"),
    `  ${C.dim}by category (ranked by impact):${C.reset}`,
    ...byCat.map(c => formatRow(c, maxSaved, catWidth)),
    `\n  ${C.dim}daily trend:${C.reset}`,
    ...byDay.map(d => formatDayRow(d, maxSaved, avgPct)),
    failCount > 0 ? `\n  ${C.dim}failures:${C.reset}\n${failLines.join("\n")}` : "",
    `\n${divider}`,
    `  ${C.dim}DB: ${rtkHistoryDb()}${C.reset}\n`,
  ].filter(Boolean).join("\n")
}

function formatShare(agg) {
  if (!agg || agg.totalCmds === 0) return `${C.dim}⚡ no RTK data yet${C.reset}`
  const { totalCmds, totalSaved, avgPct, failCount } = agg
  return (
    `${C.brightGreen}⚡ RTK:${C.reset}` +
    ` ${C.white}${totalCmds}${C.reset} cmds` +
    ` · ${C.brightGreen}${fmtNum(totalSaved)}${C.reset} saved` +
    ` · ${C.brightCyan}${avgPct.toFixed(1)}%${C.reset} avg` +
    (failCount ? ` · ${C.yellow}${failCount} failures${C.reset}` : "")
  )
}

function formatToday(agg) {
  const cmds  = agg?.todayCmds  || []
  const fails = agg?.todayFails || []

  if (cmds.length === 0 && fails.length === 0) {
    return `${C.yellow}RTK today — no commands today${C.reset}\n`
  }

  const totalSaved = cmds.reduce((s, r) => s + (r.saved_tokens || 0), 0)
  const totalInput = cmds.reduce((s, r) => s + (r.input_tokens || 0), 0)
  const avgPct = totalInput > 0 ? (totalSaved / totalInput) * 100 : 0
  const totalCmds = cmds.length
  const failCount = fails.length
  const failRate = totalCmds + failCount > 0
    ? (failCount / (totalCmds + failCount)) * 100 : 0

  // By category (same classifier as aggregateAll)
  const cats = {}
  for (const r of cmds) {
    const cat = classify(r.original_cmd)
    if (!cats[cat]) cats[cat] = { saved: 0, input: 0, count: 0 }
    cats[cat].saved  += r.saved_tokens || 0
    cats[cat].input  += r.input_tokens || 0
    cats[cat].count  += 1
  }
  const byCat = Object.entries(cats)
    .map(([name, d]) => ({
      name,
      saved: d.saved,
      pct: d.input > 0 ? (d.saved / d.input) * 100 : 0,
      count: d.count,
    }))
    .sort((a, b) => b.saved - a.saved)

  const catWidth = Math.max(12, ...byCat.map(c => c.name.length))
  const maxSaved = byCat[0]?.saved || 1

  const failLines = fails.slice(0, 5).map(f => {
    const short = (f.raw_command || "").slice(0, 48)
    return `  ${C.red}✗${C.reset} ${short.padEnd(48)} ${C.dim}parse failure${C.reset}`
  })
  if (failCount > 5) failLines.push(`  ${C.dim}… and ${failCount - 5} more${C.reset}`)

  const divider = `${C.dim}${"─".repeat(60)}${C.reset}`

  return [
    `\n${C.bold}${C.brightGreen}RTK today${C.reset}`,
    divider,
    `  ${C.white}${totalCmds}${C.reset} commands` +
    `  ·  ${C.brightGreen}${fmtNum(totalSaved)}${C.reset} tokens saved` +
    `  ·  ${C.brightCyan}${avgPct.toFixed(1)}%${C.reset} avg` +
    (failCount > 0
      ? `  ·  ${C.yellow}${failCount}${C.reset} failures (${C.red}${failRate.toFixed(0)}%${C.reset})`
      : ""),
    "",
    `  ${C.dim}by category (today):${C.reset}`,
    ...byCat.map(c => formatRow(c, maxSaved, catWidth)),
    failCount > 0
      ? `\n  ${C.dim}failures (today):${C.reset}\n${failLines.join("\n")}`
      : "",
    `\n${divider}`,
    `  ${C.dim}DB: ${rtkHistoryDb()}${C.reset}\n`,
  ].filter(Boolean).join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const share    = args.includes("--share")
  const today    = args.includes("--today")
  const sinceIdx = args.indexOf("--since")
  const sinceArg = sinceIdx !== -1 ? args[sinceIdx + 1] : null
  const projIdx  = args.indexOf("--project")
  const projArg  = projIdx !== -1 ? args[projIdx + 1] : null

  let sinceDays = null
  if (sinceArg !== null) {
    const m = /^(\d+)$/.exec(sinceArg)
    if (!m) {
      process.stderr.write(`ctx_plugin gain: --since takes a number (e.g. 7)\n`)
      process.exit(2)
    }
    sinceDays = parseInt(m[1], 10)
  }

  if (projArg !== null && sinceDays === null) {
    sinceDays = 90 // default to 90d when filtering by project
  }

  const agg = await aggregateAll({ sinceDays, project: projArg, today })

  if (share) {
    process.stdout.write(formatShare(agg) + "\n")
  } else if (today) {
    process.stdout.write(formatToday(agg) + "\n")
  } else {
    process.stdout.write(formatGain(agg, { sinceDays, project: projArg }))
  }
}

main().catch(err => {
  process.stderr.write(`ctx_plugin gain: ${err.message}\n`)
  process.exit(1)
})
