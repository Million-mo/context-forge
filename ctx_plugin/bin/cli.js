#!/usr/bin/env node
/**
 * ctx_plugin — CLI
 *
 * Thin dispatcher around bin/install.js and bin/uninstall.js.
 * RTK, Caveman, and Routing are installed/removed independently.
 *
 * Usage:
 *   ctx_plugin install [--rtk|--caveman|--routing|--all] [--force]
 *   ctx_plugin uninstall [--rtk|--caveman|--routing|--all]
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

    const routingInstalled = existsSync(join(OC_DIR, "plugins", "routing.mjs"))

    console.log(`\nctx_plugin doctor  →  ${OC_DIR}\n`)
    console.log(`  rtk binary:         ${hasRtk ? "✓ found" : "✗ not found (plugin will skip itself)"}`)
    console.log(`  rtk.ts installed:   ${rtkInstalled ? "✓" : "✗"}`)
    console.log(`  caveman skills:     ${cavInstalled ? "✓" : "✗"}`)
    console.log(`  routing.mjs:        ${routingInstalled ? "✓" : "✗"}`)
    console.log(`  cavecrew agents:    ${agentsInstalled ? "✓" : "✗"}`)
    console.log()
    break
  }
  case "gain": {
    run("gain.js", args)
    break
  }
  default: {
    console.log([
      "",
      "ctx_plugin — RTK + Caveman + Routing for OpenCode",
      "",
      "Usage:",
      "  ctx_plugin install [--rtk|--caveman|--routing|--all] [--force]",
      "  ctx_plugin uninstall [--rtk|--caveman|--routing|--all]",
      "  ctx_plugin doctor",
      "  ctx_plugin gain [--all|--since Nd|--today] [--project <name>] [--share]",
      "",
      "Targets:",
      "  --all      install/remove all components (default)",
      "  --rtk      RTK bash-rewrite plugin only",
      "  --caveman  Caveman skills + agents + AGENTS.md only",
      "  --routing  Routing security + guidance plugin only",
      "  --force    overwrite existing files",
      "",
      "Examples:",
      "  ctx_plugin install              # install all",
      "  ctx_plugin install --caveman   # Caveman only",
      "  ctx_plugin install --routing  # Routing only",
      "  ctx_plugin uninstall --rtk     # remove RTK, keep others",
      "  ctx_plugin doctor             # show install status",
      "  ctx_plugin gain              # RTK token savings report",
      "  ctx_plugin gain --today       # today's commands (detailed log)",
      "  ctx_plugin gain --since 7     # last 7 days",
      "  ctx_plugin gain --share       # one-line summary",
      "",
    ].join("\n"))
  }
}
