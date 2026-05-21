#!/usr/bin/env node
/**
 * ctx_plugin uninstall script
 *
 * Removes the RTK plugin from OpenCode's config directory and
 * cleans up any stale opencode.json entries left by ctx_plugin.
 *
 * Usage: node bin/uninstall.js
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..") // eslint-disable-line @typescript-eslint/no-unused-vars

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

// ── main ─────────────────────────────────────────────────────────────

const OC_DIR = opencodeDir()
console.log(`\nctx_plugin uninstall → ${OC_DIR}\n`)

// 1. Remove plugin file
const PLUGIN_FILE = join(OC_DIR, "plugins", "rtk.ts")
if (existsSync(PLUGIN_FILE)) {
  rmSync(PLUGIN_FILE)
  console.log(`  ✓ removed  ←  ${PLUGIN_FILE}`)
} else {
  console.log(`  - plugins/rtk.ts: not present, skipping`)
}

// 2. Remove plugins dir if empty
const pluginsDir = join(OC_DIR, "plugins")
if (existsSync(pluginsDir)) {
  const entries = readdirSync(pluginsDir)
  if (entries.length === 0) {
    rmSync(pluginsDir)
    console.log("  ✓ removed empty plugins dir")
  }
}

// 3. Prune stale ctx_plugin entries from opencode.json
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
