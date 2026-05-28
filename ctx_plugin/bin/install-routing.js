#!/usr/bin/env node
/**
 * ctx_plugin — Routing install
 *
 * Installs the routing plugin (routing.mjs) into OpenCode's plugin directory.
 *
 * Usage:
 *   node bin/install-routing.js [--force]
 */

import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import {
  opencodeDir,
  rpad,
} from "./_helpers.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..")

const FORCE = process.argv.includes("--force")
const OC_DIR = opencodeDir()

console.log(`\nRouting plugin install  →  ${OC_DIR}\n`)

// ── locate source ───────────────────────────────────────────────────

const PLUGIN_SRC_TS  = join(ROOT, "src", "routing-plugin.ts")
const PLUGIN_SRC_MJS = join(ROOT, "src", "routing-plugin.mjs")

let pluginSource
if (existsSync(PLUGIN_SRC_MJS)) {
  pluginSource = PLUGIN_SRC_MJS
} else if (existsSync(PLUGIN_SRC_TS)) {
  pluginSource = PLUGIN_SRC_TS
} else {
  console.error("  ✗ src/routing-plugin.ts (or .mjs) not found — nothing to install")
  process.exit(1)
}

const PLUGIN_DST_DIR = join(OC_DIR, "plugins")
const PLUGIN_DST = join(PLUGIN_DST_DIR, "routing.mjs")

// ── copy ─────────────────────────────────────────────────────────

mkdirSync(PLUGIN_DST_DIR, { recursive: true })

if (existsSync(PLUGIN_DST) && !FORCE) {
  console.log(`  ${rpad("✓", 2)} ${rpad("routing.mjs", 14)} already exists  (use --force to overwrite)`)
} else {
  try {
    copyFileSync(pluginSource, PLUGIN_DST)
    console.log(`  ✓ routing.mjs  →  ${PLUGIN_DST}`)
  } catch (e) {
    console.error(`  ✗ routing.mjs: ${e.message}`)
    process.exit(1)
  }
}

console.log("\nDone. Restart opencode to activate routing plugin.\n")
