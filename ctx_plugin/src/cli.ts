#!/usr/bin/env node
/**
 * ctx_plugin CLI - Install/uninstall for RTK + Caveman + Routing plugin.
 *
 * MCP servers are now in mcps/mcp_ctx_tool and mcps/mcp_ctx_summary.
 * Use their own install scripts or scripts/install-all.ts instead.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPluginRoot(): string {
  return resolve(__dirname, "..");
}

function getOpencodeConfigPath(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME && resolve(process.env.XDG_CONFIG_HOME, "opencode")) ||
    (process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "opencode")
      : resolve(homedir(), ".config", "opencode"));
  return resolve(configDir, "opencode.json");
}

function getPluginsDir(): string {
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME && resolve(process.env.XDG_CONFIG_HOME, "opencode")) ||
    (process.platform === "win32"
      ? resolve(process.env.APPDATA || resolve(homedir(), "AppData", "Roaming"), "opencode")
      : resolve(homedir(), ".config", "opencode"));
  return resolve(configDir, "plugins");
}

// ─────────────────────────────────────────────────────────
// Component: Caveman Plugin
// ─────────────────────────────────────────────────────────

function installCavemanPlugin(): { success: boolean; message: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = resolve(pluginsDir, "caveman.mjs");
  const buildScript = resolve(getPluginRoot(), "bin", "build-plugins.mjs");

  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  if (!existsSync(buildScript)) {
    return { success: false, message: `build-plugins.mjs not found at ${buildScript}. Run: cd ctx_plugin && npm install && npm run build` };
  }

  try {
    execSync(`node "${buildScript}"`, { stdio: "pipe", cwd: getPluginRoot() });
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer };
    return { success: false, message: `build-plugins.mjs failed:\n${err.stderr?.toString() ?? err.message}` };
  }

  if (!existsSync(pluginPath)) {
    return { success: false, message: `caveman.mjs not generated at ${pluginPath}` };
  }

  return { success: true, message: `Caveman plugin installed at ${pluginPath}. Restart opencode to use.` };
}

function uninstallCavemanPlugin(): { success: boolean; message: string } {
  const pluginPath = resolve(getPluginsDir(), "caveman.mjs");
  if (!existsSync(pluginPath)) {
    return { success: true, message: `Caveman plugin is not installed.` };
  }

  const content = readFileSync(pluginPath, "utf-8");
  if (!content.includes("CAVEMAN")) {
    return { success: false, message: `Unknown plugin at ${pluginPath}. Will not remove.` };
  }

  try {
    rmSync(pluginPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return {
        success: false,
        message: `Permission denied. The file may be locked by another process (e.g. opencode).\nClose opencode and run: ctx_plugin uninstall caveman`
      };
    }
    throw err;
  }
  return { success: true, message: `Caveman plugin removed from ${pluginPath}` };
}

function statusCavemanPlugin(): { installed: boolean; details: Record<string, string> } {
  const pluginPath = resolve(getPluginsDir(), "caveman.mjs");
  const pluginsDir = getPluginsDir();
  return {
    installed: existsSync(pluginPath),
    details: {
      path: pluginPath,
      dir_exists: existsSync(pluginsDir) ? "yes" : "no",
    },
  };
}

// ─────────────────────────────────────────────────────────
// Component: Routing Plugin
// ─────────────────────────────────────────────────────────

function installRoutingPlugin(): { success: boolean; message: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = resolve(pluginsDir, "routing.mjs");
  const buildScript = resolve(getPluginRoot(), "bin", "build-plugins.mjs");

  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  if (!existsSync(buildScript)) {
    return { success: false, message: `build-plugins.mjs not found at ${buildScript}. Run: cd ctx_plugin && npm install && npm run build` };
  }

  try {
    execSync(`node "${buildScript}"`, { stdio: "pipe", cwd: getPluginRoot() });
  } catch (e) {
    const err = e as { message?: string; stderr?: Buffer };
    return { success: false, message: `build-plugins.mjs failed:\n${err.stderr?.toString() ?? err.message}` };
  }

  if (!existsSync(pluginPath)) {
    return { success: false, message: `routing.mjs not generated at ${pluginPath}` };
  }

  return { success: true, message: `Routing plugin installed at ${pluginPath}. Restart opencode to use.` };
}

function uninstallRoutingPlugin(): { success: boolean; message: string } {
  const pluginPath = resolve(getPluginsDir(), "routing.mjs");
  if (!existsSync(pluginPath)) {
    return { success: true, message: `Routing plugin is not installed.` };
  }

  const content = readFileSync(pluginPath, "utf-8");
  if (!content.includes("RoutingPlugin")) {
    return { success: false, message: `Unknown plugin at ${pluginPath}. Will not remove.` };
  }

  try {
    rmSync(pluginPath);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return {
        success: false,
        message: `Permission denied. The file may be locked by another process (e.g. opencode).\nClose opencode and run: ctx_plugin uninstall routing`
      };
    }
    throw err;
  }
  return { success: true, message: `Routing plugin removed from ${pluginPath}` };
}

function statusRoutingPlugin(): { installed: boolean; details: Record<string, string> } {
  const pluginPath = resolve(getPluginsDir(), "routing.mjs");
  const pluginsDir = getPluginsDir();
  return {
    installed: existsSync(pluginPath),
    details: {
      path: pluginPath,
      dir_exists: existsSync(pluginsDir) ? "yes" : "no",
    },
  };
}

// ─────────────────────────────────────────────────────────
// Component: RTK
// ─────────────────────────────────────────────────────────

function checkRtkAvailable(): boolean {
  try {
    execSync("which rtk", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function statusRtk(): { installed: boolean; details: Record<string, string> } {
  const available = checkRtkAvailable();
  return {
    installed: available,
    details: {
      available: available ? "yes" : "no",
      message: available
        ? "RTK binary found in PATH"
        : "RTK binary not found - install from https://github.com/rtk-ai/rtk",
    },
  };
}

// ─────────────────────────────────────────────────────────
// Component: Caveman Skills
// ─────────────────────────────────────────────────────────

function statusCavemanSkills(): { installed: boolean; details: Record<string, string> } {
  const skillsDir = resolve(getOpencodeConfigPath(), "..", "skills", "caveman");
  const flagPath = resolve(homedir(), ".config", "opencode", ".caveman-active");

  return {
    installed: existsSync(skillsDir),
    details: {
      skills: existsSync(skillsDir) ? "installed" : "not installed",
      flag: existsSync(flagPath) ? `active (${readFileSync(flagPath, "utf-8").trim()})` : "inactive",
    },
  };
}

// ─────────────────────────────────────────────────────────
// Component: Security Policy
// ─────────────────────────────────────────────────────────

async function printSecurity(): Promise<void> {
  console.log(`\nctx_plugin Security Policies`);
  console.log(`─`.repeat(50));

  let policies: Array<{ deny: string[]; allow: string[]; ask: string[] }> = [];
  try {
    const mod = await import("./security.js");
    policies = mod.readBashPolicies();
  } catch {
    policies = [];
  }

  if (policies.length === 0) {
    console.log(`  No policies loaded (using built-in defaults)`);
  } else {
    for (const policy of policies) {
      if (policy.deny.length > 0) console.log(`  Deny patterns: ${policy.deny.length}`);
      if (policy.allow.length > 0) console.log(`  Allow patterns: ${policy.allow.length}`);
      if (policy.ask.length > 0) console.log(`  Ask patterns: ${policy.ask.length}`);
    }
  }

  const failMode = process.env.CTX_PLUGIN_REQUIRE_SECURITY;
  console.log(`\nFail mode: ${failMode === "1" ? "CLOSED (deny on policy match)" : "OPEN (warn + allow)"}`);
  console.log(`Set CTX_PLUGIN_REQUIRE_SECURITY=1 to enable fail-closed mode.`);
}

// ─────────────────────────────────────────────────────────
// Status report
// ─────────────────────────────────────────────────────────

function printStatus(): void {
  console.log(`\nctx_plugin Status Report`);
  console.log(`─`.repeat(50));

  // Caveman plugin
  const cavemanPlugin = statusCavemanPlugin();
  console.log(`\nCaveman plugin:`);
  if (cavemanPlugin.installed) {
    console.log(`  ✅ Installed`);
    console.log(`    Path: ${cavemanPlugin.details.path}`);
  } else {
    console.log(`  ❌ Not installed`);
    console.log(`    Run 'ctx_plugin install caveman' to install`);
  }

  // Routing plugin
  const routingPlugin = statusRoutingPlugin();
  console.log(`\nRouting plugin:`);
  if (routingPlugin.installed) {
    console.log(`  ✅ Installed`);
    console.log(`    Path: ${routingPlugin.details.path}`);
  } else {
    console.log(`  ❌ Not installed`);
    console.log(`    Run 'ctx_plugin install routing' to install`);
  }

  // RTK
  const rtk = statusRtk();
  console.log(`\nRTK (command rewriting):`);
  if (rtk.details.available === "yes") {
    console.log(`  ✅ Available`);
  } else {
    console.log(`  ⚠️ Not available`);
    console.log(`    ${rtk.details.message}`);
  }

  // Caveman skills
  const caveman = statusCavemanSkills();
  console.log(`\nCaveman (communication mode):`);
  console.log(`  Skills: ${caveman.details.skills}`);
  console.log(`  Mode: ${caveman.details.flag}`);

  // MCP note
  console.log(`\nMCP Servers (see mcps/):`);
  console.log(`  Use 'mcps/mcp_ctx_tool/dist/install.js' for code execution + search`);
  console.log(`  Use 'mcps/mcp_ctx_summary/dist/install.js' for context summary + recall`);
  console.log(`  Or: npx tsx scripts/install-all.ts`);
}

function printDoctor(): void {
  console.log(`\nctx_plugin Diagnostics`);
  console.log(`─`.repeat(50));
  console.log(`Plugin root: ${getPluginRoot()}`);
  console.log(`Config: ${getOpencodeConfigPath()}`);
  console.log(`Plugins: ${getPluginsDir()}`);
  printStatus();
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

function help(): void {
  console.log(`
ctx_plugin CLI - Plugin management for opencode

Components:
  caveman   - Caveman communication compression plugin
  routing   - Routing + security + guidance plugin
  rtk       - RTK binary availability check

Commands:
  ctx_plugin install [caveman|routing]   Install plugin
  ctx_plugin uninstall [caveman|routing] Uninstall plugin
  ctx_plugin status                       Show installation status
  ctx_plugin doctor                       Run diagnostics
  ctx_plugin security                     Show security policies

Examples:
  ctx_plugin install              # install both Caveman + Routing
  ctx_plugin install caveman     # Caveman only
  ctx_plugin install routing     # Routing only
  ctx_plugin uninstall caveman   # remove Caveman, keep Routing
  ctx_plugin status             # show all component statuses
  ctx_plugin doctor             # run diagnostics

MCP Servers:
  MCP servers are now in mcps/:
    mcps/mcp_ctx_tool/      - Code execution + FTS5 search
    mcps/mcp_ctx_summary/   - Context summary + recall
  Install: npx tsx scripts/install-all.ts
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const target = args[1];

  switch (command) {
    case "install": {
      if (!target || target === "all" || target === "caveman" || target === "routing") {
        const results: string[] = [];
        if (!target || target === "all" || target === "caveman") {
          const r = installCavemanPlugin();
          console.log(r.message);
          if (!r.success) results.push(r.message);
        }
        if (!target || target === "all" || target === "routing") {
          const r = installRoutingPlugin();
          console.log(r.message);
          if (!r.success) results.push(r.message);
        }
        if (results.length > 0) process.exit(1);
      } else {
        console.log(`Unknown component: ${target}`);
        console.log(`Available: caveman, routing`);
      }
      break;
    }

    case "uninstall": {
      if (!target || target === "all" || target === "caveman" || target === "routing") {
        const results: string[] = [];
        if (!target || target === "all" || target === "caveman") {
          const r = uninstallCavemanPlugin();
          console.log(r.message);
          if (!r.success) results.push(r.message);
        }
        if (!target || target === "all" || target === "routing") {
          const r = uninstallRoutingPlugin();
          console.log(r.message);
          if (!r.success) results.push(r.message);
        }
        if (results.length > 0) process.exit(1);
      } else {
        console.log(`Unknown component: ${target}`);
      }
      break;
    }

    case "status":
      printStatus();
      break;

    case "doctor":
      printDoctor();
      break;

    case "security":
      await printSecurity();
      break;

    case "help":
    default:
      help();
      break;
  }
}

main().catch(console.error);
