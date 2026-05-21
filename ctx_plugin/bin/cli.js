#!/usr/bin/env node
/**
 * ctx_plugin — CLI for managing the RTK OpenCode plugin.
 *
 * Usage:
 *   ctx_plugin install      # Deploy rtk.ts → OpenCode plugins dir
 *   ctx_plugin uninstall    # Remove rtk.ts from OpenCode plugins dir
 *   ctx_plugin doctor       # Check rtk availability + install status
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..")
const cmd = process.argv[2]

// ── helpers ──────────────────────────────────────────────────────────

function opencodeDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode")
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA ?? join(os.homedir(), "AppData", "Roaming"),
      "opencode",
    )
  }
  return join(os.homedir(), ".config", "opencode")
}

function readJson(path) {
  const raw = readFileSync(path, "utf8")
  const cleaned = raw.replace(/\/\/[^\n]*/g, "")
  try {
    return JSON.parse(cleaned)
  } catch {
    return {}
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n")
}

function rtkAvailable() {
  try {
    execSync("which rtk", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

// ── install ──────────────────────────────────────────────────────────

function install() {
  const OC_DIR = opencodeDir()
  console.log(`\nctx_plugin install → ${OC_DIR}\n`)

  const RTK_SRC = join(ROOT, "src", "rtk.ts")
  const PLUGINS_DST = join(OC_DIR, "plugins")
  mkdirSync(PLUGINS_DST, { recursive: true })
  try {
    copyFileSync(RTK_SRC, join(PLUGINS_DST, "rtk.ts"))
    console.log(`  ✓ rtk.ts  →  ${PLUGINS_DST}/rtk.ts`)
  } catch (e) {
    console.error(`  ✗ rtk.ts: ${e.message}`)
    process.exit(1)
  }

  const OC_JSON = join(OC_DIR, "opencode.json")
  if (existsSync(OC_JSON)) {
    const cfg = readJson(OC_JSON)
    let changed = false
    if (cfg.permission) {
      if (cfg.permission.fibonacci) { delete cfg.permission.fibonacci; changed = true }
      if (Object.keys(cfg.permission).length === 0) delete cfg.permission
    }
    if (changed) {
      writeJson(OC_JSON, cfg)
      console.log("  ✓ pruned stale opencode.json entries")
    }
  } else {
    writeJson(OC_JSON, {})
    console.log("  ✓ created opencode.json")
  }

  if (!rtkAvailable()) {
    console.warn("\n  ⚠  rtk not found on PATH — plugin will be inactive until rtk is installed\n")
  }

  console.log("\nDone. Restart opencode to activate ctx_plugin.\n")
}

// ── uninstall ────────────────────────────────────────────────────────

function uninstall() {
  const OC_DIR = opencodeDir()
  console.log(`\nctx_plugin uninstall → ${OC_DIR}\n`)

  const PLUGIN_FILE = join(OC_DIR, "plugins", "rtk.ts")
  if (existsSync(PLUGIN_FILE)) {
    rmSync(PLUGIN_FILE)
    console.log(`  ✓ removed  ←  ${PLUGIN_FILE}`)
  } else {
    console.log(`  - plugins/rtk.ts: not present, skipping`)
  }

  const pluginsDir = join(OC_DIR, "plugins")
  if (existsSync(pluginsDir)) {
    const entries = readdirSync(pluginsDir)
    if (entries.length === 0) {
      rmSync(pluginsDir)
      console.log("  ✓ removed empty plugins dir")
    }
  }

  const OC_JSON = join(OC_DIR, "opencode.json")
  if (existsSync(OC_JSON)) {
    const cfg = readJson(OC_JSON)
    let changed = false
    if (cfg.permission) {
      if (cfg.permission.fibonacci) { delete cfg.permission.fibonacci; changed = true }
      if (Object.keys(cfg.permission).length === 0) delete cfg.permission
    }
    if (changed) {
      writeJson(OC_JSON, cfg)
      console.log("  ✓ pruned stale opencode.json entries")
    } else {
      console.log("  - opencode.json: nothing to prune")
    }
  }

  console.log("\nDone. Restart opencode to apply changes.\n")
}

// ── doctor ───────────────────────────────────────────────────────────

function doctor() {
  console.log(`\nctx_plugin doctor\n`)

  const installed = existsSync(join(opencodeDir(), "plugins", "rtk.ts"))
  const hasRtk = rtkAvailable()

  console.log(`  rtk binary:    ${hasRtk ? "✓ found" : "✗ not found (plugin will skip itself)"}`)
  console.log(`  plugin file:   ${installed ? "✓ installed" : "✗ not installed (run: ctx_plugin install)"}`)
  console.log(`  opencode dir:  ${opencodeDir()}\n`)
}

// ── entry ────────────────────────────────────────────────────────────

switch (cmd) {
  case "install":
    install()
    break
  case "uninstall":
    uninstall()
    break
  case "doctor":
    doctor()
    break
  default:
    console.log([
      "",
      "ctx_plugin — manage the RTK OpenCode plugin",
      "",
      "Usage:",
      "  ctx_plugin install       Deploy rtk.ts to OpenCode",
      "  ctx_plugin uninstall     Remove rtk.ts from OpenCode",
      "  ctx_plugin doctor        Show install status",
      "",
    ].join("\n"))
}
