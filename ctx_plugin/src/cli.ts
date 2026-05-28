#!/usr/bin/env node
/**
 * ctx_plugin CLI - Install/uninstall for RTK + Caveman plugin.
 *
 * MCP servers are now in mcps/mcp_ctx_tool and mcps/mcp_ctx_summary.
 * Use their own install scripts or scripts/install-all.ts instead.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

function getPluginFilePath(): string {
  return resolve(getPluginsDir(), "caveman.mjs");
}

// ─────────────────────────────────────────────────────────
// Component: Plugin (RTK + Caveman)
// ─────────────────────────────────────────────────────────

function installPlugin(): { success: boolean; message: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = getPluginFilePath();
  const sourcePath = resolve(getPluginRoot(), "src", "plugin.ts");

  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  if (!existsSync(sourcePath)) {
    return { success: false, message: `Plugin source not found at ${sourcePath}` };
  }

  const pluginContent = generatePluginMjs(sourcePath);

  if (existsSync(pluginPath)) {
    return { success: true, message: `Plugin already exists at ${pluginPath}` };
  }

  writeFileSync(pluginPath, pluginContent);
  return { success: true, message: `Plugin installed at ${pluginPath}. Restart opencode to use.` };
}

function uninstallPlugin(): { success: boolean; message: string } {
  const pluginPath = getPluginFilePath();
  if (!existsSync(pluginPath)) {
    return { success: true, message: `Plugin is not installed.` };
  }

  const content = readFileSync(pluginPath, "utf-8");
  if (!content.includes("ctx_plugin")) {
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
  return { success: true, message: `Plugin removed from ${pluginPath}` };
}

function statusPlugin(): { installed: boolean; details: Record<string, string> } {
  const pluginPath = getPluginFilePath();
  const pluginsDir = getPluginsDir();

  return {
    installed: existsSync(pluginPath),
    details: {
      path: pluginPath,
      dir_exists: existsSync(pluginsDir) ? "yes" : "no",
    },
  };
}

function generatePluginMjs(sourcePath: string): string {
  return `/**
 * ctx_plugin — unified opencode plugin (RTK + Caveman)
 *
 * Auto-generated from ctx_plugin/src/plugin.ts
 * Do not edit manually - changes will be overwritten.
 */

${readFileSync(sourcePath, "utf-8")}

export { CtxPlugin as ctxPlugin, default as ctxPlugin };
`;
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
// Component: Caveman
// ─────────────────────────────────────────────────────────

function statusCaveman(): { installed: boolean; details: Record<string, string> } {
  const plugin = statusPlugin();
  const flagPath = resolve(homedir(), ".config", "opencode", ".caveman-active");

  return {
    installed: plugin.installed,
    details: {
      plugin: plugin.installed ? "installed" : "not installed",
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

  // Plugin
  const plugin = statusPlugin();
  console.log(`\nPlugin (RTK + Caveman):`);
  if (plugin.installed) {
    console.log(`  ✅ Installed`);
    console.log(`    Path: ${plugin.details.path}`);
  } else {
    console.log(`  ❌ Not installed`);
    console.log(`    Run 'ctx_plugin install plugin' to install`);
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

  // Caveman
  const caveman = statusCaveman();
  console.log(`\nCaveman (communication mode):`);
  console.log(`  Plugin: ${caveman.details.plugin}`);
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
ctx_plugin CLI - Plugin management for opencode (RTK + Caveman)

Components:
  plugin   - Opencode plugin (RTK + Caveman)

Commands:
  ctx_plugin install [plugin]   Install plugin
  ctx_plugin uninstall [plugin] Uninstall plugin
  ctx_plugin status             Show installation status
  ctx_plugin doctor             Run diagnostics
  ctx_plugin security           Show security policies

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
  const component = args[1];

  switch (command) {
    case "install": {
      const target = component || "plugin";
      if (target === "plugin" || target === "rtk" || target === "caveman" || target === "all") {
        const result = installPlugin();
        console.log(result.message);
      } else {
        console.log(`Unknown component: ${target}`);
        console.log(`Available: plugin`);
      }
      break;
    }

    case "uninstall": {
      const target = component || "plugin";
      if (target === "plugin" || target === "rtk" || target === "caveman" || target === "all") {
        const result = uninstallPlugin();
        console.log(result.message);
        if (!result.success) {
          console.log(`Tip: close opencode first, then retry.`);
        }
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
