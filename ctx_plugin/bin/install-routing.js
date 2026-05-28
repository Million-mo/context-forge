#!/usr/bin/env node
/**
 * ctx_plugin — Routing install
 *
 * Installs the routing plugin (routing.mjs) into OpenCode's plugin directory.
 * Uses bin/build-plugins.mjs to generate .mjs with bundled dependencies.
 *
 * Usage:
 *   node bin/install-routing.js [--force]
 */

import { existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

import {
  opencodeDir,
  rpad,
} from "./_helpers.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..")

const FORCE = process.argv.includes("--force")
const OC_DIR = opencodeDir()

console.log(`\nRouting plugin install  →  ${OC_DIR}\n`)

const BUILD_SCRIPT = join(ROOT, "bin", "build-plugins.mjs")
const PLUGIN_DST_DIR = join(OC_DIR, "plugins")
const PLUGIN_DST = join(PLUGIN_DST_DIR, "routing.mjs")

if (!existsSync(BUILD_SCRIPT)) {
  console.error(`  ✗ build-plugins.mjs not found at ${BUILD_SCRIPT}`)
  console.error(`  Run: cd ctx_plugin && npm install && npm run build`)
  process.exit(1)
}

if (existsSync(PLUGIN_DST) && !FORCE) {
  console.log(`  ${rpad("✓", 2)} ${rpad("routing.mjs", 14)} already exists  (use --force to overwrite)`)
  console.log(`\nDone. Restart opencode to activate routing plugin.\n`)
  process.exit(0)
}

// Run build-plugins.mjs which compiles TS + generates .mjs + copies deps
const result = spawnSync("node", [BUILD_SCRIPT], {
  cwd: ROOT,
  stdio: "inherit",
})

if (result.status !== 0) {
  console.error(`  ✗ build-plugins.mjs failed (exit ${result.status})`)
  console.error(`  Try: cd ctx_plugin && npm install && npm run build`)
  process.exit(1)
}

if (!existsSync(PLUGIN_DST)) {
  console.error(`  ✗ routing.mjs not generated at ${PLUGIN_DST}`)
  process.exit(1)
}

console.log(`\nDone. Restart opencode to activate routing plugin.\n`)
