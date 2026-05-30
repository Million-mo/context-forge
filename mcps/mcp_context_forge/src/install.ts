/**
 * CLI for registering mcp_context_forge in opencode.json MCP config.
 *
 * Usage:
 *   node dist/install.js            (register)
 *   node dist/install.js --uninstall (remove)
 *
 * IMPORTANT: server.ts must be bundled with esbuild (scripts/build-server.mjs)
 * BEFORE running this installer. Use `npm run build:server` first.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { registerMcp, unregisterMcp } from "@context-forge/shared-types/install-helper";

const LABEL = "mcp_context_forge";
const SERVER_NAME = "mcp_context_forge";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Use esbuild-bundled server.js (built via scripts/build-server.mjs)
// __dirname is dist/ so we resolve server.js in the same directory
const serverDist = resolve(__dirname, "server.js");

const args = process.argv.slice(2);
if (args.includes("--uninstall")) {
  unregisterMcp(LABEL, SERVER_NAME);
} else {
  registerMcp(LABEL, SERVER_NAME, serverDist, ["node", serverDist]);
}
