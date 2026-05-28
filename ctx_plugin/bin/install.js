#!/usr/bin/env node
/**
 * ctx_plugin — unified install dispatcher
 *
 * Calls install-rtk.js, install-caveman.js, and/or install-routing.js based on flags.
 *
 * Usage:
 *   node bin/install.js              — install RTK + Caveman + Routing (all)
 *   node bin/install.js --rtk       — RTK only
 *   node bin/install.js --caveman   — Caveman only
 *   node bin/install.js --routing   — Routing only
 *   node bin/install.js --all       — all (same as no flag)
 *   node bin/install.js --force      — pass --force to sub-installers
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const BIN = join(dirname(__filename))

function run(name, args) {
  const path = join(BIN, name)
  if (!existsSync(path)) {
    console.error(`  ✗ ${name} not found`)
    return false
  }
  const result = spawnSync("node", [path, ...args], { stdio: "inherit" })
  return result.status === 0
}

const FORCE = process.argv.includes("--force") ? ["--force"] : []

const installRtk     = process.argv.includes("--rtk")
const installCaveman = process.argv.includes("--caveman")
const installRouting  = process.argv.includes("--routing")
const installAll     = !installRtk && !installCaveman && !installRouting

let ok = true

if (installAll || installRtk) {
  ok = run("install-rtk.js", FORCE) && ok
}

if (installAll || installCaveman) {
  ok = run("install-caveman.js", FORCE) && ok
}

if (installAll || installRouting) {
  ok = run("install-routing.js", FORCE) && ok
}

if (!ok) process.exit(1)
