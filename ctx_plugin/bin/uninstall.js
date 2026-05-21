#!/usr/bin/env node
/**
 * ctx_plugin — uninstaller
 *
 * Removes RTK and/or Caveman from OpenCode's config directory.
 *
 * Usage:
 *   node bin/uninstall.js              — remove both RTK + Caveman
 *   node bin/uninstall.js --rtk        — RTK only
 *   node bin/uninstall.js --caveman    — Caveman only
 *   node bin/uninstall.js --all         — both (same as no flag)
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

import { opencodeDir, rpad } from "./_helpers.js"

const __filename = fileURLToPath(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const ROOT = join(dirname(__filename), "..")

const OC_DIR = opencodeDir()

const uninstallRtk     = process.argv.includes("--rtk")
const uninstallCaveman = process.argv.includes("--caveman")
const uninstallAll     = !uninstallRtk && !uninstallCaveman

function section(name) {
  console.log(`\n## ${name}`)
}

function removeFile(path, label) {
  if (!existsSync(path)) {
    console.log(`  ${rpad("-", 2)} ${label}: not present`)
    return
  }
  const isDir = statSync(path).isDirectory()
  rmSync(path, isDir ? { recursive: true } : undefined)
  console.log(`  ✓ removed  ←  ${path}`)
}

// ── RTK ──────────────────────────────────────────────────────────

if (uninstallAll || uninstallRtk) {
  section("RTK")

  removeFile(join(OC_DIR, "plugins", "rtk.ts"), "plugins/rtk.ts")

  // Clean empty plugins dir
  const pluginsDir = join(OC_DIR, "plugins")
  if (existsSync(pluginsDir)) {
    try {
      if (readdirSync(pluginsDir).length === 0) {
        rmSync(pluginsDir)
        console.log(`  ✓ removed empty plugins/ dir`)
      }
    } catch {}
  }
}

// ── Caveman ──────────────────────────────────────────────────────

if (uninstallAll || uninstallCaveman) {
  section("Caveman")

  removeFile(join(OC_DIR, "skills"), "skills/")

  // Remove agents dir (if it was installed by ctx_plugin)
  const agentsDir = join(OC_DIR, "agents")
  if (existsSync(agentsDir)) {
    rmSync(agentsDir, { recursive: true })
    console.log(`  ✓ removed  ←  ${agentsDir}/`)
  } else {
    console.log(`  ${rpad("-", 2)} agents/: not present`)
  }

  removeFile(join(OC_DIR, "AGENTS.md"), "AGENTS.md")

  // Clean empty opencode.json plugin entry
  const OC_JSON = join(OC_DIR, "opencode.json")
  if (existsSync(OC_JSON)) {
    const raw = readFileSync(OC_JSON, "utf8")
    const cleaned = raw.replace(/\/\/[^\n]*/g, "")
    try {
      const cfg = JSON.parse(cleaned)
      let changed = false
      if (cfg.plugin) {
        const before = cfg.plugin.length
        cfg.plugin = (Array.isArray(cfg.plugin) ? cfg.plugin : [cfg.plugin])
          .filter((p) => p !== "./plugins/caveman.mjs")
        if (cfg.plugin.length === 0) delete cfg.plugin
        changed = cfg.plugin?.length !== before
      }
      if (changed) {
        writeFileSync(OC_JSON, JSON.stringify(cfg, null, 2) + "\n")
        console.log(`  ✓ pruned ctx_plugin entries from opencode.json`)
      }
    } catch {}
  }

  // Remove caveman config dir
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

  removeFile(CAVEMAN_CONFIG_DIR, "~/.config/caveman/")

  // Remove opencode plugin file if it exists
  removeFile(join(OC_DIR, "plugins", "caveman.mjs"), "plugins/caveman.mjs")
}

console.log("\nDone. Restart opencode to apply changes.\n")
