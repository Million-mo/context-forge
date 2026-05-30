/**
 * build-server.mjs — Bundle the unified MCP server with esbuild.
 *
 * This replaces `tsc` for mcp_context_forge because tsc's type checking
 * triggers Node.js 22's ESM/CJS mixed-module resolution bug when
 * source files import from sibling packages without package.json.
 *
 * Flow:
 *  1. Build shared-types (tsc, ESM output)
 *  2. Delete stale CJS .js files from mcp_ctx_tool + mcp_ctx_summary
 *     (these have incorrect package imports that break Node 22 ESM loader)
 *  3. Bundle server.ts with esbuild (external: shared-types, MCP SDK)
 *  4. Output to mcps/mcp_context_forge/dist/server.js
 */

import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MCP_CXT = path.join(ROOT, "mcps", "mcp_context_forge");
const DIST_DIR = path.join(MCP_CXT, "dist");

function cleanDir(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanDir(full);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      fs.unlinkSync(full);
    }
  }
}

console.log("[build-server] Cleaning stale CJS/d.ts files...");
cleanDir(path.join(ROOT, "mcps", "mcp_ctx_tool", "src"));
cleanDir(path.join(ROOT, "mcps", "mcp_ctx_summary", "src"));
console.log("[build-server] Clean complete.");

// esbuild bundle
console.log("[build-server] Bundling server with esbuild...");
const entryPoints = [
  path.join(MCP_CXT, "src", "server.ts"),
  path.join(MCP_CXT, "src", "install.ts"),
];

for (const entry of entryPoints) {
  const name = path.basename(entry, ".ts");
  console.log(`  Bundling ${name}...`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: DIST_DIR,
    splitting: false,
    minify: false,
    sourcemap: false,
    target: "node22",
    external: [
      "@modelcontextprotocol/sdk",
      "@context-forge/shared-types",
    ],
    logLevel: "info",
  });
}

console.log("[build-server] Done — output:", path.join(DIST_DIR, "server.js"));
