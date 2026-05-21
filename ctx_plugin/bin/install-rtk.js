#!/usr/bin/env node
/**
 * ctx_plugin — RTK install
 *
 * Installs the RTK bash-rewrite plugin into OpenCode's plugin directory.
 * OpenCode auto-discovers plugins from .opencode/plugins/ — no opencode.json entry needed.
 *
 * Usage:
 *   node bin/install-rtk.js [--force]
 */

import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  opencodeDir,
  rtkAvailable,
  rpad,
  section,
} from "./_helpers.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..")

const FORCE = process.argv.includes("--force")
const OC_DIR = opencodeDir()

console.log(`\nRTK install  →  ${OC_DIR}\n`)

// ── locate source ───────────────────────────────────────────────────

const PLUGIN_SRC_TS  = join(ROOT, "src", "rtk.ts")
const PLUGIN_SRC_MJS = join(ROOT, "src", "rtk.mjs")

let pluginSource
if (existsSync(PLUGIN_SRC_MJS)) {
  pluginSource = PLUGIN_SRC_MJS
} else if (existsSync(PLUGIN_SRC_TS)) {
  pluginSource = PLUGIN_SRC_TS
} else {
  console.error("  ✗ src/rtk.ts (or .mjs) not found — nothing to install")
  process.exit(1)
}

const PLUGIN_DST_DIR = join(OC_DIR, "plugins")
const PLUGIN_DST = join(PLUGIN_DST_DIR, "rtk.ts")   // .ts suffix matches uninstall.js expectation

// ── copy ───────────────────────────────────────────────────────────

mkdirSync(PLUGIN_DST_DIR, { recursive: true })

if (existsSync(PLUGIN_DST) && !FORCE) {
  console.log(`  ${rpad("✓", 2)} ${rpad("rtk.ts", 14)} already exists  (use --force to overwrite)`)
} else {
  try {
    copyFileSync(pluginSource, PLUGIN_DST)
    console.log(`  ✓ rtk.ts  →  ${PLUGIN_DST}`)
  } catch (e) {
    console.error(`  ✗ rtk.ts: ${e.message}`)
    process.exit(1)
  }
}

// ── warn if rtk binary missing ──────────────────────────────────────

if (!rtkAvailable()) {
  console.warn("\n  ⚠  rtk not found on PATH — RTK plugin will log a warning on startup\n")
}

console.log("\nDone. Restart opencode to activate RTK.\n")
