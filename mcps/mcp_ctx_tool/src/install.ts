/**
 * CLI for registering mcp_ctx_tool in opencode.json MCP config.
 *
 * Usage:
 *   node dist/install.js       (register)
 *   node dist/install.js --uninstall  (remove)
 */

import { resolve, dirname } from "path"
import { fileURLToPath } from "url"
import { registerMcp, unregisterMcp } from "@context-forge/shared-types/install-helper"

const LABEL = "mcp_ctx_tool"
const SERVER_NAME = "mcp_ctx_tool"
const __dirname = dirname(fileURLToPath(import.meta.url))
const serverPath = resolve(__dirname, "server.js")

const args = process.argv.slice(2)
if (args.includes("--uninstall")) {
  unregisterMcp(LABEL, SERVER_NAME)
} else {
  registerMcp(LABEL, SERVER_NAME, serverPath)
}
