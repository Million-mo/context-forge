#!/usr/bin/env node
/**
 * ctx_plugin — Caveman install
 *
 * Installs Caveman skills, agents, AGENTS.md, and config into OpenCode's config directory.
 *
 * Usage:
 *   node bin/install-caveman.js [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

import {
  opencodeDir,
  copyDirRecursive,
  writeJson,
  rpad,
  section,
} from "./_helpers.js"

const __filename = fileURLToPath(import.meta.url)
const ROOT = join(dirname(__filename), "..")

const FORCE = process.argv.includes("--force")
const OC_DIR = opencodeDir()

console.log(`\nCaveman install  →  ${OC_DIR}\n`)

// ── skills ────────────────────────────────────────────────────────

const SKILLS_SRC = join(ROOT, "skills")
const SKILLS_DST = join(OC_DIR, "skills")

section("Skills")
if (existsSync(SKILLS_SRC)) {
  try {
    copyDirRecursive(SKILLS_SRC, SKILLS_DST)
    console.log(`  ✓ skills/  →  ${SKILLS_DST}`)
  } catch (e) {
    console.error(`  ✗ skills/: ${e.message}`)
  }
} else {
  console.log(`  ⚠ skills/ not found at ${SKILLS_SRC}`)
}

// ── agents ───────────────────────────────────────────────────────

const AGENTS_SRC = join(ROOT, "agents")
const AGENTS_DST = join(OC_DIR, "agents")

section("Agents")
if (existsSync(AGENTS_SRC)) {
  try {
    copyDirRecursive(AGENTS_SRC, AGENTS_DST)
    console.log(`  ✓ agents/  →  ${AGENTS_DST}`)
  } catch (e) {
    console.error(`  ✗ agents/: ${e.message}`)
  }
} else {
  console.log(`  ⚠ agents/ not found at ${AGENTS_SRC}`)
}

// ── AGENTS.md ────────────────────────────────────────────────────

const AGENTS_MD = join(OC_DIR, "AGENTS.md")
const AGENTS_CONTENT = `# ctx_plugin — RTK + Caveman

This AGENTS.md provides Tier-3 always-on rules for ctx_plugin.
Skills are loaded from the \`skills/\` directory.

---

@./skills/caveman/SKILL.md
@./skills/caveman-commit/SKILL.md
@./skills/caveman-review/SKILL.md
@./skills/caveman-compress/SKILL.md
`

section("AGENTS.md")
if (!existsSync(AGENTS_MD) || FORCE) {
  try {
    writeFileSync(AGENTS_MD, AGENTS_CONTENT)
    console.log(`  ✓ AGENTS.md  →  ${AGENTS_MD}`)
  } catch (e) {
    console.error(`  ✗ AGENTS.md: ${e.message}`)
  }
} else {
  console.log(`  ${rpad("✓", 2)} AGENTS.md already exists  (use --force to overwrite)`)
}

// ── Caveman config dir ────────────────────────────────────────────

const CAVEMAN_CONFIG_DIR = (() => {
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "caveman")
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(os.homedir(), "AppData", "Roaming"),
      "caveman",
    )
  }
  return join(os.homedir(), ".config", "caveman")
})()

const CAVEMAN_CONFIG_FILE = join(CAVEMAN_CONFIG_DIR, "config.json")

section("Config")
if (!existsSync(CAVEMAN_CONFIG_FILE)) {
  mkdirSync(CAVEMAN_CONFIG_DIR, { recursive: true })
  writeJson(CAVEMAN_CONFIG_FILE, JSON.stringify({ defaultMode: "full" }, null, 2))
  console.log(`  ✓ created  →  ${CAVEMAN_CONFIG_FILE}`)
  console.log(`             defaultMode: "full"`)
} else {
  console.log(`  ${rpad("✓", 2)} config already exists  (${CAVEMAN_CONFIG_FILE})`)
}

console.log("\nDone. Restart opencode to activate Caveman.\n")
console.log("Caveman modes:")
console.log("  /caveman [lite|full|ultra|wenyan]  — activate compression")
console.log("  /caveman-commit                     — terse commit messages")
console.log("  /caveman-review                     — one-line code review")
console.log("  /caveman-compress <file>            — compress memory file")
console.log("  /caveman-help                       — quick reference")
console.log("  stop caveman / normal mode          — deactivate\n")
console.log("Set default mode:")
console.log("  export CAVEMAN_DEFAULT_MODE=ultra   — env var (highest priority)")
console.log("  or edit ~/.config/caveman/config.json\n")
console.log("Lifetime stats: ctx_plugin stats [--all|--since Nd|Nh] [--share]\n")
