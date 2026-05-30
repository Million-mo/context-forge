/**
 * CLI for registering mcp_context_forge in opencode.json MCP config.
 *
 * Usage:
 *   node dist/install.js            (register)
 *   node dist/install.js --uninstall (remove)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { registerMcp, unregisterMcp } from "@context-forge/shared-types/install-helper";

const LABEL = "mcp_context_forge";
const SERVER_NAME = "mcp_context_forge";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Use npx tsx to run TypeScript source (cross-package imports require tsx)
const serverSource = resolve(__dirname, "..", "src", "server.ts");

const args = process.argv.slice(2);
if (args.includes("--uninstall")) {
  unregisterMcp(LABEL, SERVER_NAME);
} else {
  registerMcp(LABEL, SERVER_NAME, serverSource, ["npx", "tsx", serverSource]);
}
