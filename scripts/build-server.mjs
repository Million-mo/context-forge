/**
 * build-server.mjs — Bundle the unified MCP server with esbuild.
 *
 * After the plugin-registry refactor, mcp_ctx_tool and mcp_ctx_summary
 * are merged into mcp_context_forge. This script bundles the server entry
 * point for distribution (single file, no ESM resolution issues).
 */

import * as esbuild from "esbuild";
import * as path from "node:path";
import * as fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MCP_CXT = path.join(ROOT, "mcps", "mcp_context_forge");
const DIST_DIR = path.join(MCP_CXT, "dist");

// Clean stale .js / .d.ts from dist (but keep .tsbuildinfo)
function cleanDist(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      cleanDist(full);
    } else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      fs.unlinkSync(full);
    }
  }
}

console.log("[build-server] Cleaning dist...");
cleanDist(DIST_DIR);
console.log("[build-server] Clean complete.");

const entryPoints = [
  path.join(MCP_CXT, "src", "server.ts"),
  path.join(MCP_CXT, "src", "install.ts"),
];

for (const entry of entryPoints) {
  const name = path.basename(entry, ".ts");
  console.log(`[build-server] Bundling ${name}...`);
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

console.log("[build-server] Done.");
console.log(`  dist/server.js  — MCP server entry point`);
console.log(`  dist/install.js — MCP registration CLI`);
