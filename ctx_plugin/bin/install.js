#!/usr/bin/env node
/**
 * ctx_plugin install script
 *
 * Installs ctx_plugin into opencode's config directory:
 *   - src/plugin.ts   →  ~/.config/opencode/plugins/ctx_plugin/plugin.ts
 *   - src/tools.ts   →  ~/.config/opencode/tools/fibonacci.ts
 *   - opencode.json  →  ensure fibonacci permission exists
 *
 * Run: node bin/install.js
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import os from "node:os"

const __dirname = fileURLToPath(import.meta.url)
const ROOT = join(__dirname, "..")

function opencodeDir() {
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode")
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(os.homedir(), "AppData", "Roaming"), "opencode")
  }
  return join(os.homedir(), ".config", "opencode")
}

function patchOpencodeJson(cfgPath) {
  const raw = readFileSync(cfgPath, "utf8")
  const cleaned = raw.replace(/\/\/[^\n]*/g, "")
  let cfg
  try { cfg = JSON.parse(cleaned) } catch { cfg = {} }
  if (!cfg.permission) cfg.permission = {}
  if (!cfg.permission.fibonacci) cfg.permission.fibonacci = "allow"
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n")
  console.log(`  patched opencode.json`)
}

const OC_DIR = opencodeDir()
console.log(`\nctx_plugin install → ${OC_DIR}\n`)

// 1. Plugin
const PLUGIN_SRC = join(ROOT, "src", "plugin.ts")
const PLUGIN_DST = join(OC_DIR, "plugins", "ctx_plugin")
mkdirSync(PLUGIN_DST, { recursive: true })
try {
  copyFileSync(PLUGIN_SRC, join(PLUGIN_DST, "plugin.ts"))
  console.log(`  installed plugin → ${PLUGIN_DST}/plugin.ts`)
} catch (e) {
  console.error(`  failed to copy plugin: ${e.message}`)
}

// 2. Tools
const TOOLS_SRC = join(ROOT, "src", "tools.ts")
const TOOLS_DST = join(OC_DIR, "tools")
mkdirSync(TOOLS_DST, { recursive: true })
if (existsSync(TOOLS_SRC)) {
  try {
    copyFileSync(TOOLS_SRC, join(TOOLS_DST, "fibonacci.ts"))
    console.log(`  installed fibonacci tool → ${TOOLS_DST}/fibonacci.ts`)
  } catch (e) {
    console.error(`  failed to copy tools: ${e.message}`)
  }
}

// 3. opencode.json
const OC_JSON = join(OC_DIR, "opencode.json")
if (existsSync(OC_JSON)) {
  patchOpencodeJson(OC_JSON)
}

console.log("\nDone. Restart opencode to activate ctx_plugin.\n")
