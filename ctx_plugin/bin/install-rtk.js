#!/usr/bin/env node
/**
 * ctx_plugin — RTK install
 *
 * Two-step install:
 *   1. Ensure the rtk binary is on PATH  (runs the official install.sh if missing)
 *   2. Copy the OpenCode plugin wrapper  (rtk.ts) into OpenCode's plugin directory.
 *
 * OpenCode auto-discovers plugins from .opencode/plugins/ — no opencode.json entry needed.
 *
 * Usage:
 *   node bin/install-rtk.js [--force]
 */

import { existsSync, mkdirSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"

import {
  opencodeDir,
  rtkAvailable,
  rpad,
} from "./_helpers.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..")

const FORCE = process.argv.includes("--force")
const OC_DIR = opencodeDir()

// ── step 1: ensure rtk binary is on PATH ───────────────────────────────

if (!rtkAvailable()) {
  console.log("\nrtk binary not found — running official installer...\n")
  try {
    execSync(
      "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
      { stdio: "inherit" },
    )
  } catch (e) {
    console.error("\n  ✗  rtk install.sh failed\n")
    process.exit(1)
  }

  if (!rtkAvailable()) {
    console.error(
      "\n  ✗  rtk binary still not on PATH after install.\n" +
      "     Add $HOME/.local/bin to your PATH and restart your terminal, then run:\n" +
      "       ctx_plugin install --rtk\n",
    )
    process.exit(1)
  }
  console.log()
} else {
  const version = execSync("rtk --version 2>/dev/null || true", { encoding: "utf8" }).trim()
  console.log(`\nRTK binary  →  ✓  ${version || "found"}\n`)
}

// ── step 2: copy OpenCode plugin wrapper ───────────────────────────────

console.log(`Plugin install  →  ${OC_DIR}\n`)

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

console.log("\nDone. Restart opencode to activate RTK.\n")
