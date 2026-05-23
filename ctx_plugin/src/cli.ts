/**
 * ctx_plugin CLI - Modular install/uninstall for RTK, Caveman, and MCP server.
 *
 * Components:
 *   - rtk:     Command rewriting via `rtk rewrite` (opencode plugin hook)
 *   - caveman: Communication compression mode (opencode plugin hook)
 *   - mcp:     Code execution + FTS5 search (MCP server)
 *   - all:     Install all components
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────

function getPluginRoot(): string {
  // dist/cli.js → dist/ → ctx_plugin/
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

function getMcpServerPath(): string {
  return resolve(getPluginRoot(), "dist", "mcp", "server.js");
}

function getPluginFilePath(): string {
  return resolve(getPluginsDir(), "caveman.mjs");
}

// ─────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────

interface OpencodeConfig {
  $schema?: string;
  permission?: Record<string, unknown>;
  mcp?: Record<string, {
    type?: "local" | "remote";
    command?: string[];
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    timeout?: number;
    url?: string;
    headers?: Record<string, string>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

function readOpencodeConfig(): OpencodeConfig {
  const path = getOpencodeConfigPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeOpencodeConfig(config: OpencodeConfig): void {
  const path = getOpencodeConfigPath();
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

// ─────────────────────────────────────────────────────────
// Component: MCP Server
// ─────────────────────────────────────────────────────────

function installMcp(): { success: boolean; message: string } {
  const serverPath = getMcpServerPath();
  if (!existsSync(serverPath)) {
    return { success: false, message: `MCP server not found at ${serverPath}. Run 'npm run build' first.` };
  }

  const config = readOpencodeConfig();
  if (!config.mcp) config.mcp = {};

  if (config.mcp["ctx_plugin"]) {
    return { success: true, message: `ctx_plugin MCP server is already installed.` };
  }

  config.mcp["ctx_plugin"] = {
    type: "local",
    command: ["node", serverPath],
  };

  writeOpencodeConfig(config);
  return { success: true, message: `ctx_plugin MCP server installed. Restart opencode to use.` };
}

function uninstallMcp(): { success: boolean; message: string } {
  const config = readOpencodeConfig();
  if (!config.mcp?.["ctx_plugin"]) {
    return { success: true, message: `ctx_plugin MCP server is not installed.` };
  }

  delete config.mcp["ctx_plugin"];
  if (Object.keys(config.mcp).length === 0) {
    delete config.mcp;
  }

  writeOpencodeConfig(config);
  return { success: true, message: `ctx_plugin MCP server uninstalled. Restart opencode to stop using.` };
}

function statusMcp(): { installed: boolean; details: Record<string, string> } {
  const config = readOpencodeConfig();
  const server = config.mcp?.["ctx_plugin"];
  const serverPath = getMcpServerPath();

  return {
    installed: !!server,
    details: {
      type: server?.type || "-",
      command: server?.command?.join(" ") || "-",
      path: serverPath,
      exists: existsSync(serverPath) ? "yes" : "no",
      match: server?.command?.[1] === serverPath ? "yes" : "no",
    },
  };
}

// ─────────────────────────────────────────────────────────
// Component: Plugin (RTK + Caveman)
// ─────────────────────────────────────────────────────────

function installPlugin(): { success: boolean; message: string } {
  const pluginsDir = getPluginsDir();
  const pluginPath = getPluginFilePath();
  const sourcePath = resolve(getPluginRoot(), "src", "plugin.ts");

  // Create plugins directory if needed
  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  // Build if needed
  if (!existsSync(sourcePath)) {
    return { success: false, message: `Plugin source not found at ${sourcePath}` };
  }

  // Copy plugin to plugins directory
  // The plugin is transpiled inline as .mjs for opencode to load
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

  // Check if it's our plugin
  const content = readFileSync(pluginPath, "utf-8");
  if (!content.includes("ctx_plugin")) {
    return { success: false, message: `Unknown plugin at ${pluginPath}. Will not remove.` };
  }

  // Just warn, don't delete to avoid data loss
  return { success: true, message: `Plugin exists at ${pluginPath}. Remove manually or use 'ctx_plugin uninstall --force'` };
}

function uninstallPluginForce(): { success: boolean; message: string } {
  const pluginPath = getPluginFilePath();
  if (!existsSync(pluginPath)) {
    return { success: true, message: `Plugin is not installed.` };
  }

  rmSync(pluginPath);
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
  // Read the plugin source and inline it for opencode
  // This is a simplified version - in production you'd transpile
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
// Purge
// ─────────────────────────────────────────────────────────

async function printPurge(args: string[]): Promise<void> {
  console.log(`\nctx_plugin Purge`);
  console.log(`─`.repeat(50));

  try {
    const { initSessionDb, cleanupOldSessions, getSessionDbPath, deleteSession } = await import("./session-db.js");
    initSessionDb();

    const daysArg = args.find(a => a.startsWith("--days="));
    const sessionArg = args.find(a => a.startsWith("--session="));
    const dryRun = args.includes("--dry-run");

    if (sessionArg) {
      const sessionId = sessionArg.split("=")[1];
      if (!dryRun) {
        deleteSession(sessionId);
        console.log(`  Deleted session: ${sessionId}`);
      } else {
        console.log(`  Would delete session: ${sessionId}`);
      }
    } else {
      const days = daysArg ? parseInt(daysArg.split("=")[1], 10) : 0;
      if (!dryRun) {
        const purged = cleanupOldSessions(days);
        console.log(`  Purged ${purged} sessions older than ${days} days`);
      } else {
        console.log(`  Would purge sessions older than ${days} days`);
      }
    }

    console.log(`  Database: ${getSessionDbPath()}`);
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ─────────────────────────────────────────────────────────
// Status report
// ─────────────────────────────────────────────────────────

function printStatus(): void {
  console.log(`\nctx_plugin Status Report`);
  console.log(`─`.repeat(50));

  // MCP
  const mcp = statusMcp();
  console.log(`\nMCP Server:`);
  if (mcp.installed) {
    console.log(`  ✅ Installed`);
    console.log(`    Type: ${mcp.details.type}`);
    console.log(`    Command: ${mcp.details.command}`);
    console.log(`    Server exists: ${mcp.details.exists}`);
    if (mcp.details.match === "no") {
      console.log(`    ⚠️ Path mismatch - reinstall with 'ctx_plugin install mcp'`);
    }
  } else {
    console.log(`  ❌ Not installed`);
    console.log(`    Run 'ctx_plugin install mcp' to install`);
  }

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
}

function printDoctor(): void {
  console.log(`\nctx_plugin Diagnostics`);
  console.log(`─`.repeat(50));
  console.log(`Plugin root: ${getPluginRoot()}`);
  console.log(`Config: ${getOpencodeConfigPath()}`);
  console.log(`Plugins: ${getPluginsDir()}`);
  console.log(`MCP Server: ${getMcpServerPath()}`);

  printStatus();
}

// ─────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────

function help(): void {
  console.log(`
ctx_plugin CLI - Modular MCP capabilities for opencode

Components:
  rtk     - Command rewriting via \`rtk rewrite\`
  caveman - Communication compression mode
  mcp     - Code execution + FTS5 search
  plugin  - Opencode plugin (includes RTK + Caveman)

Commands:
	ctx_plugin install [component]   Install component(s)
	ctx_plugin uninstall [component] Uninstall component(s)
	ctx_plugin status               Show installation status
	ctx_plugin doctor               Run diagnostics
	ctx_plugin security             Show security policies
	ctx_plugin purge [--days=N]     Purge old session data

Examples:
	ctx_plugin install mcp          Install MCP server only
	ctx_plugin install plugin       Install plugin (RTK + Caveman)
	ctx_plugin install all          Install all components
	ctx_plugin uninstall mcp        Remove MCP server
	ctx_plugin status               Check what's installed
	ctx_plugin security            Show security policies
	ctx_plugin purge --days=7      Purge sessions older than 7 days
	ctx_plugin purge --dry-run     Preview what would be purged
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "help";
  const component = args[1];

  switch (command) {
    case "install": {
      const target = component || "all";
      if (target === "all") {
        console.log("Installing all components...\n");
        const mcp = installMcp();
        console.log(`MCP: ${mcp.message}`);
        const plugin = installPlugin();
        console.log(`Plugin: ${plugin.message}`);
      } else if (target === "mcp") {
        const result = installMcp();
        console.log(result.message);
      } else if (target === "plugin" || target === "rtk" || target === "caveman") {
        const result = installPlugin();
        console.log(result.message);
      } else {
        console.log(`Unknown component: ${target}`);
        console.log(`Available: mcp, plugin, rtk, caveman, all`);
      }
      break;
    }

    case "uninstall": {
      const target = component || "all";
      if (target === "all") {
        console.log("Uninstalling all components...\n");
        const mcp = uninstallMcp();
        console.log(`MCP: ${mcp.message}`);
        const plugin = uninstallPlugin();
        console.log(`Plugin: ${plugin.message}`);
      } else if (target === "mcp") {
        const result = uninstallMcp();
        console.log(result.message);
      } else if (target === "plugin" || target === "rtk" || target === "caveman") {
        if (args[2] === "--force") {
          const result = uninstallPluginForce();
          console.log(result.message);
        } else {
          const result = uninstallPlugin();
          console.log(result.message);
          if (!result.success) {
            console.log(`Use 'ctx_plugin uninstall ${target} --force' to force removal`);
          }
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

    case "purge":
      await printPurge(args.slice(1));
      break;

    case "help":
    default:
      help();
      break;
  }
}

main().catch(console.error);
