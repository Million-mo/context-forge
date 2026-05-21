#!/usr/bin/env node
/**
 * ctx_plugin — CLI
 *
 * Thin dispatcher around bin/install.js and bin/uninstall.js.
 * RTK and Caveman are installed/removed independently.
 *
 * Usage:
 *   ctx_plugin install [--rtk|--caveman|--all] [--force]
 *   ctx_plugin uninstall [--rtk|--caveman|--all]
 *   ctx_plugin doctor
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execSync } from "node:child_process"
import os from "node:os"

const __filename = fileURLToPath(import.meta.url)
const BIN = dirname(__filename)

function run(name, scriptArgs) {
  const path = join(BIN, name)
  if (!existsSync(path)) {
    console.error(`  ✗ ${name} not found`)
    return false
  }
  const result = spawnSync("node", [path, ...scriptArgs], { stdio: "inherit" })
  return result.status === 0
}

function rtkAvailable() {
  try {
    execSync("which rtk", { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

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

const cmd = process.argv[2]
const args = process.argv.slice(3)

switch (cmd) {
  case "install": {
    run("install.js", args)
    break
  }
  case "uninstall": {
    run("uninstall.js", args)
    break
  }
  case "doctor": {
    const OC_DIR = opencodeDir()
    const hasRtk         = rtkAvailable()
    const rtkInstalled   = existsSync(join(OC_DIR, "plugins", "rtk.ts"))
    const cavInstalled   = existsSync(join(OC_DIR, "skills", "caveman"))
    const agentsInstalled = existsSync(join(OC_DIR, "agents"))

    console.log(`\nctx_plugin doctor  →  ${OC_DIR}\n`)
    console.log(`  rtk binary:         ${hasRtk ? "✓ found" : "✗ not found (plugin will skip itself)"}`)
    console.log(`  rtk.ts installed:   ${rtkInstalled ? "✓" : "✗"}`)
    console.log(`  caveman skills:     ${cavInstalled ? "✓" : "✗"}`)
    console.log(`  cavecrew agents:    ${agentsInstalled ? "✓" : "✗"}`)
    console.log()
    break
  }
  default: {
    console.log([
      "",
      "ctx_plugin — RTK + Caveman for OpenCode",
      "",
      "Usage:",
      "  ctx_plugin install [--rtk|--caveman|--all] [--force]",
      "  ctx_plugin uninstall [--rtk|--caveman|--all]",
      "  ctx_plugin doctor",
      "",
      "Targets:",
      "  --all      install/remove both (default)",
      "  --rtk      RTK bash-rewrite plugin only",
      "  --caveman  Caveman skills + agents + AGENTS.md only",
      "  --force    overwrite existing files",
      "",
      "Examples:",
      "  ctx_plugin install              # install both",
      "  ctx_plugin install --caveman   # Caveman only",
      "  ctx_plugin uninstall --rtk     # remove RTK, keep Caveman",
      "  ctx_plugin doctor              # show install status",
      "",
    ].join("\n"))
  }
}
