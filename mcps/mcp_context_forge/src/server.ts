/**
 * Context Forge — Unified MCP Server (v0.5.0)
 *
 * Architecture: Plugin Registry Pattern
 * - Each tool is a self-contained plugin in src/tools/<group>/
 * - PluginRegistry handles dispatch, error wrapping, feature flags
 * - No more if/else dispatch in this file
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { PluginRegistry } from "./plugin-registry.js";
import { loadLLMConfig, createLLMClient } from "@context-forge/shared-types";
import { PolyglotExecutor } from "./exec-engine/executor.js";
import { detectRuntimes } from "./exec-engine/runtime.js";
import { ContentStore } from "./index-engine/content-store.js";
import {
  setExecutor, setRuntimes, setStore, setRecallLLM, getProjectDir,
} from "./services.js";

// ── Feature flags ─────────────────────────────────────────────────────────────

const FEATURES = {
  execution: !process.env.CTX_DISABLE_EXECUTION,
  memory: !process.env.CTX_DISABLE_MEMORY,
};

// ── Recall LLM setup ─────────────────────────────────────────────────────────

const llmConfig = loadLLMConfig();
const recallLLM = createLLMClient(llmConfig);
setRecallLLM(recallLLM);

// ── Executor setup ──────────────────────────────────────────────────────────

if (FEATURES.execution) {
  const runtimes = detectRuntimes();
  const executor = new PolyglotExecutor({ runtimes });
  setExecutor(executor);
  setRuntimes(runtimes);
}

// ── Content Store setup ─────────────────────────────────────────────────────

const contentStore = new ContentStore(getProjectDir());
setStore(contentStore);

// ── Plugin Registry ─────────────────────────────────────────────────────────

export const registry = new PluginRegistry(FEATURES);

// ── Tool imports ─────────────────────────────────────────────────────────────

import { infraTools } from "./tools/infra/index.js";
import { execTools } from "./tools/exec/index.js";
import { indexTools } from "./tools/index/index.js";
import { memoryTools } from "./tools/memory/index.js";

// ── Register tools ────────────────────────────────────────────────────────────

for (const tool of infraTools) registry.register(tool);
for (const tool of execTools) registry.register(tool);
for (const tool of indexTools) registry.register(tool);
for (const tool of memoryTools) registry.register(tool);

// ── MCP Server ───────────────────────────────────────────────────────────────

const VERSION = "0.5.0";

const server = new McpServer(
  { name: "mcp_context_forge", version: VERSION },
  { capabilities: { tools: {} } },
);

// ── List tools ───────────────────────────────────────────────────────────────

server.server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: registry.toMcpToolList() };
});

// ── Call tool ───────────────────────────────────────────────────────────────

server.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  return registry.handleCall(name, args) as Promise<CallToolResult>;
});

// ── Startup ─────────────────────────────────────────────────────────────────

async function main() {
  console.error(`[mcp_context_forge] v${VERSION} starting...`);
  console.error(`[mcp_context_forge] Features: execution=${FEATURES.execution}, memory=${FEATURES.memory}`);
  console.error(`[mcp_context_forge] Recall LLM: ${recallLLM ? "enabled" : "disabled (no API key)"}`);
  console.error(`[mcp_context_forge] Project dir: ${getProjectDir()}`);

  (globalThis as Record<string, unknown>).__ctxRegistry = registry;
  (globalThis as Record<string, unknown>).__recallLLM = recallLLM;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp_context_forge] Connected");
}

main().catch((error) => {
  console.error("[mcp_context_forge] Fatal:", error);
  process.exit(1);
});
