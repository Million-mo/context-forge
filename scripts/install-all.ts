/**
 * One-shot installer for the unified MCP server.
 *
 * Usage:
 *   npx tsx scripts/install-all.ts           (install)
 *   npx tsx scripts/install-all.ts --uninstall  (remove)
 *
 * Registers mcp_context_forge (unified execution + indexing + memory) into opencode.json.
 * Also unregisters the legacy mcp_ctx_tool and mcp_ctx_summary if present.
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const UNINSTALL = process.argv.includes("--uninstall");

function run(cmd: string, cwd: string, label: string): void {
  console.log(`\n[install-all] ${label}`);
  console.log(`  $ ${cmd}`);
  try {
    execSync(cmd, { cwd, stdio: "inherit" });
    console.log(`  ✓ ${label} done`);
  } catch (err) {
    console.error(`  ✗ ${label} failed`);
    process.exit(1);
  }
}

function install(): void {
  console.log("=== Installing Context Forge unified MCP ===\n");

  // 1. Unregister legacy MCPs if they exist
  const legacyTool = resolve(ROOT, "mcps", "mcp_ctx_tool", "dist", "install.js");
  if (existsSync(legacyTool)) {
    run(`node "${legacyTool}" --uninstall`, resolve(ROOT, "mcps", "mcp_ctx_tool"), "unregister legacy mcp_ctx_tool");
  }

  const legacySummary = resolve(ROOT, "mcps", "mcp_ctx_summary", "dist", "install.js");
  if (existsSync(legacySummary)) {
    run(`node "${legacySummary}" --uninstall`, resolve(ROOT, "mcps", "mcp_ctx_summary"), "unregister legacy mcp_ctx_summary");
  }

  // 2. Register unified MCP
  const forgeInstall = resolve(ROOT, "mcps", "mcp_context_forge", "dist", "install.js");
  if (existsSync(forgeInstall)) {
    run(`node "${forgeInstall}"`, resolve(ROOT, "mcps", "mcp_context_forge"), "mcp_context_forge (unified)");
  } else {
    console.warn("  ! mcp_context_forge install script not found, skipping (build it first: cd mcps/mcp_context_forge && npm run build)");
  }

  console.log("\n=== All done ===");
  console.log("Restart opencode to pick up the new unified MCP server.");
}

function uninstall(): void {
  console.log("=== Uninstalling Context Forge MCP ===\n");

  const forgeInstall = resolve(ROOT, "mcps", "mcp_context_forge", "dist", "install.js");
  if (existsSync(forgeInstall)) {
    run(`node "${forgeInstall}" --uninstall`, resolve(ROOT, "mcps", "mcp_context_forge"), "mcp_context_forge");
  }

  console.log("\n=== All removed ===");
}

if (UNINSTALL) {
  uninstall();
} else {
  install();
}
