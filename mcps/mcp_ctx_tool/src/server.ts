/**
 * MCP Server for mcp_ctx_tool
 *
 * Provides sandboxed code execution and FTS5 search capabilities.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PolyglotExecutor } from "./executor.js";
import { getAvailableLanguages, getRuntimeSummary, getRuntimeInfo } from "./runtime.js";
import { ContentStore } from "./store.js";
import {
  initSessionDb,
  cleanupOldSessions,
  deleteSession,
  getSessionDbPath,
  insertEvent,
  ensureSession,
  getLatestSessionId,
  getEvents,
  upsertResume,
  getResume,
  incrementCompactCount,
  type SessionEvent,
} from "./session-db.js";
import { extractToolCall, type ToolCallInfo } from "./session/extract.js";
import { buildResumeSnapshot } from "./session/snapshot.js";
import { querySessionAnalytics, formatReport } from "./session/analytics.js";

const VERSION = "0.3.0";

function getProjectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PROJECT_DIR || process.cwd();
}

const server = new McpServer(
  { name: "mcp_ctx_tool", version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }
);

const executor = new PolyglotExecutor();

let contentStore: ContentStore | null = null;

function getStore(): ContentStore {
  if (!contentStore) {
    contentStore = new ContentStore(getProjectDir());
  }
  return contentStore;
}

/**
 * Record a tool call as a classified session event.
 * Best-effort — never throws, never blocks the parent call.
 */
function recordToolEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: string,
  isError: boolean,
): void {
  try {
    const projectDir = getProjectDir();
    initSessionDb(projectDir);
    // Use latest existing session for this project, or create a new one.
    const existingSid = getLatestSessionId();
    const sid = existingSid ?? `session-${Date.now()}`;
    if (!existingSid) {
      // Fresh session — register it so future events find it
      ensureSession(sid, projectDir);
    }

    const call: ToolCallInfo = { toolName, toolInput, toolResponse, isError };
    const events = extractToolCall(sid, call, projectDir);

    for (const ev of events) {
      insertEvent(ev);
    }
  } catch {
    // best-effort only
  }
}

server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

const ExecuteSchema = z.object({
  language: z.enum(["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir"]),
  code: z.string(),
  timeout: z.number().optional(),
});

const ExecuteFileSchema = z.object({
  path: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional(),
});

const VALID_LANGUAGES = ["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir"] as const;

const BatchExecuteSchema = z.object({
  commands: z.array(z.object({
    language: z.string(),
    code: z.string(),
  })),
  sequential: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
}).transform((val) => ({
  ...val,
  commands: val.commands.map((cmd) => ({
    language: cmd.language as (typeof VALID_LANGUAGES)[number],
    code: cmd.code,
  })),
}));

const IndexSchema = z.object({
  content: z.string().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
});

const SearchSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
  source: z.string().optional(),
  contentType: z.enum(["code", "prose"]).optional(),
});

const FetchAndIndexSchema = z.object({
  url: z.string(),
  source: z.string().optional(),
});

const PurgeSchema = z.object({
  sessionId: z.string().optional(),
  daysOld: z.number().optional(),
});

server.registerTool(
  "ctx_ping",
  {
    title: "Health Check",
    description: "Health check for mcp_ctx_tool MCP server",
    inputSchema: z.object({}),
  },
  async () => ({ content: [{ type: "text", text: "pong" }] })
);

server.registerTool(
  "ctx_execute",
  {
    title: "Execute Code",
    description: "Execute code in sandbox with multiple language support",
    inputSchema: ExecuteSchema,
  },
  async (args) => {
    const result = await executor.execute({
      language: args.language,
      code: args.code,
      timeout: args.timeout ?? 30000,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "ctx_runtimes",
  {
    title: "List Available Runtimes",
    description: "List available language runtimes and their versions",
    inputSchema: z.object({}),
  },
  async () => {
    const runtimes = executor.runtimes;
    const available = getAvailableLanguages(runtimes);
    const summary = getRuntimeSummary(runtimes);
    return { content: [{ type: "text", text: JSON.stringify({ available, summary }, null, 2) }] };
  }
);

server.registerTool(
  "ctx_index",
  {
    title: "Index Content",
    description: "Index file or content into searchable FTS5 store",
    inputSchema: IndexSchema,
  },
  async (args) => {
    const store = getStore();
    if (args.path) {
      const result = await store.indexFile(args.path, { source: args.source });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (args.content) {
      const result = await store.index(args.content, { source: args.source });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Provide either 'path' or 'content'" }], isError: true };
  }
);

server.registerTool(
  "ctx_search",
  {
    title: "Search Indexed Content",
    description: "BM25 search across indexed content with RRF fusion",
    inputSchema: SearchSchema,
  },
  async (args) => {
    const store = getStore();
    const results = store.search(args.query, args.limit ?? 10, {
      source: args.source,
      contentType: args.contentType,
    });
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

server.registerTool(
  "ctx_stats",
  {
    title: "Get Store Statistics",
    description: "Get statistics about the content store",
    inputSchema: z.object({}),
  },
  async () => {
    const store = getStore();
    const stats = store.getStats();
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  }
);

server.registerTool(
  "ctx_execute_file",
  {
    title: "Execute Script File",
    description: "Read and execute a script file with sandboxed environment",
    inputSchema: ExecuteFileSchema,
  },
  async (args) => {
    const result = await executor.executeFile({
      path: args.path,
      args: args.args,
      env: args.env,
      timeout: args.timeout,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.registerTool(
  "ctx_batch_execute",
  {
    title: "Batch Execute",
    description: "Execute multiple code blocks sequentially or in parallel",
    inputSchema: BatchExecuteSchema,
  },
  async (args) => {
    const results = await executor.batchExecute({
      commands: args.commands,
      sequential: args.sequential ?? false,
      stopOnError: args.stopOnError ?? false,
    });
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

server.registerTool(
  "ctx_purge",
  {
    title: "Purge Session Data",
    description: "Clear session data from the SQLite store",
    inputSchema: PurgeSchema,
  },
  async (args) => {
    initSessionDb(getProjectDir());
    if (args.sessionId) {
      deleteSession(args.sessionId);
      return { content: [{ type: "text", text: `Deleted session: ${args.sessionId}` }] };
    }
    const purged = cleanupOldSessions(args.daysOld ?? 0);
    return { content: [{ type: "text", text: `Purged ${purged} old sessions from ${getSessionDbPath()}` }] };
  }
);

server.registerTool(
  "ctx_fetch_and_index",
  {
    title: "Fetch and Index Web Content",
    description: "Fetch web content and index it for search",
    inputSchema: FetchAndIndexSchema,
  },
  async (args) => {
    try {
      const response = await fetch(args.url, {
        headers: { "User-Agent": "mcp_ctx_tool/1.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        return { content: [{ type: "text", text: `HTTP ${response.status}: ${response.statusText}` }], isError: true };
      }
      const text = await response.text();
      const store = getStore();
      const indexResult = await store.index(text, { source: args.source ?? args.url });
      return {
        content: [{ type: "text", text: JSON.stringify({ url: args.url, size: text.length, indexed: indexResult.totalChunks, sourceId: indexResult.sourceId }, null, 2) }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  }
);

server.registerTool(
  "ctx_doctor",
  {
    title: "Run System Diagnostics",
    description: "Run system diagnostics",
    inputSchema: z.object({}),
  },
  async () => {
    const checks: Array<{ check: string; status: string; detail: string }> = [];
    const runtimes = executor.runtimes;

    for (const lang of ["javascript", "typescript", "python", "shell"] as const) {
      const rt = getRuntimeInfo(runtimes, lang);
      checks.push({
        check: `${lang} runtime`,
        status: rt.available ? "pass" : "fail",
        detail: rt.available ? `${rt.command} (${rt.version})` : "not found",
      });
    }

    try {
      const { execSync } = await import("child_process");
      const rtkVersion = execSync("rtk --version 2>/dev/null || rtk version 2>/dev/null || echo 'not found'", {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      checks.push({ check: "rtk", status: "pass", detail: rtkVersion });
    } catch {
      checks.push({ check: "rtk", status: "warn", detail: "not found in PATH" });
    }

    try {
      const store = getStore();
      const stats = store.getStats();
      checks.push({ check: "content store", status: "pass", detail: `${stats.totalChunks} chunks, ${stats.totalSources} sources` });
    } catch (e) {
      checks.push({ check: "content store", status: "fail", detail: `${e instanceof Error ? e.message : String(e)}` });
    }

    const passed = checks.filter(c => c.status === "pass").length;
    const failed = checks.filter(c => c.status === "fail").length;
    const warned = checks.filter(c => c.status === "warn").length;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ version: VERSION, platform: process.platform, node: process.version, summary: { passed, failed, warned }, checks }, null, 2),
      }],
    };
  }
);

server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "ctx_ping", description: "Health check for mcp_ctx_tool", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    {
      name: "ctx_execute",
      description: "Execute code in sandbox with multiple language support",
      inputSchema: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir"] },
          code: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["language", "code"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    { name: "ctx_runtimes", description: "List available language runtimes", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    {
      name: "ctx_index",
      description: "Index file or content into searchable store",
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" }, path: { type: "string" }, source: { type: "string" } },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "ctx_search",
      description: "Search indexed content with BM25 + trigram RRF fusion",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" }, source: { type: "string" }, contentType: { type: "string", enum: ["code", "prose"] } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    { name: "ctx_stats", description: "Get content store statistics", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    {
      name: "ctx_execute_file",
      description: "Read and execute a script file with sandboxed environment",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, args: { type: "array", items: { type: "string" } }, env: { type: "object", additionalProperties: { type: "string" } }, timeout: { type: "number" } },
        required: ["path"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: "ctx_batch_execute",
      description: "Execute multiple code blocks sequentially or in parallel",
      inputSchema: {
        type: "object",
        properties: {
          commands: { type: "array", items: { type: "object", properties: { language: { type: "string" }, code: { type: "string" } }, required: ["language", "code"] } },
          sequential: { type: "boolean" },
          stopOnError: { type: "boolean" },
        },
        required: ["commands"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    { name: "ctx_fetch_and_index", description: "Fetch web content and index it for search", inputSchema: { type: "object", properties: { url: { type: "string" }, source: { type: "string" } }, required: ["url"] }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
    { name: "ctx_doctor", description: "Run system diagnostics", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    {
      name: "ctx_purge",
      description: "Clear session data from the SQLite store",
      inputSchema: { type: "object", properties: { sessionId: { type: "string" }, daysOld: { type: "number" } } },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "ctx_session",
      description: "Session analytics — events tracked, categories, tool stats, and context savings",
      inputSchema: { type: "object", properties: { sessionId: { type: "string", description: "Optional session ID (defaults to latest)" } } },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ],
}));

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "ctx_ping") {
      return { content: [{ type: "text", text: "pong" }] };
    }

    if (name === "ctx_execute") {
      const parsed = ExecuteSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const { language, code, timeout } = parsed.data;
      const result = await executor.execute({ language, code, timeout: timeout ?? 30000 });
      recordToolEvent("ctx_execute", { language, code }, JSON.stringify(result), result.exitCode !== 0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "ctx_runtimes") {
      const runtimes = executor.runtimes;
      const available = getAvailableLanguages(runtimes);
      const summary = getRuntimeSummary(runtimes);
      return { content: [{ type: "text", text: JSON.stringify({ available, summary }, null, 2) }] };
    }

    if (name === "ctx_index") {
      const parsed = IndexSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const store = getStore();
      let result;
      if (parsed.data.path) {
        result = await store.indexFile(parsed.data.path, { source: parsed.data.source });
        recordToolEvent("ctx_index", { path: parsed.data.path }, JSON.stringify(result), false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (parsed.data.content) {
        result = await store.index(parsed.data.content, { source: parsed.data.source });
        recordToolEvent("ctx_index", { content: parsed.data.content.slice(0, 100) }, JSON.stringify(result), false);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Provide either 'path' or 'content'" }], isError: true };
    }

    if (name === "ctx_search") {
      const parsed = SearchSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const store = getStore();
      const results = store.search(parsed.data.query, parsed.data.limit ?? 10, {
        source: parsed.data.source,
        contentType: parsed.data.contentType,
      });
      recordToolEvent("ctx_search", { query: parsed.data.query, limit: parsed.data.limit }, `${results.length} results`, false);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    if (name === "ctx_stats") {
      const store = getStore();
      const stats = store.getStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }

    if (name === "ctx_execute_file") {
      const parsed = ExecuteFileSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const result = await executor.executeFile({
        path: parsed.data.path,
        args: parsed.data.args,
        env: parsed.data.env,
        timeout: parsed.data.timeout,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.exitCode !== 0 };
    }

    if (name === "ctx_batch_execute") {
      const parsed = BatchExecuteSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const result = await executor.batchExecute({
        commands: parsed.data.commands,
        sequential: parsed.data.sequential,
        stopOnError: parsed.data.stopOnError,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "ctx_fetch_and_index") {
      const parsed = FetchAndIndexSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      try {
        const response = await fetch(parsed.data.url, {
          headers: { "User-Agent": "mcp_ctx_tool/1.0" },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          return { content: [{ type: "text", text: `HTTP ${response.status}: ${response.statusText}` }], isError: true };
        }
        const text = await response.text();
        const store = getStore();
        const indexResult = await store.index(text, { source: parsed.data.source ?? parsed.data.url });
        return {
          content: [{ type: "text", text: JSON.stringify({ url: parsed.data.url, size: text.length, indexed: indexResult.totalChunks, sourceId: indexResult.sourceId }, null, 2) }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    }

    if (name === "ctx_doctor") {
      const checks = [];
      const runtimes = executor.runtimes;

      for (const lang of ["javascript", "typescript", "python", "shell"] as const) {
        const rt = getRuntimeInfo(runtimes, lang);
        checks.push({
          check: `${lang} runtime`,
          status: rt.available ? "pass" : "fail",
          detail: rt.available ? `${rt.command} (${rt.version})` : "not found",
        });
      }

      try {
        const { execSync } = await import("child_process");
        const rtkVersion = execSync("rtk --version 2>/dev/null || rtk version 2>/dev/null || echo 'not found'", {
          encoding: "utf-8",
          timeout: 3000,
        }).trim();
        checks.push({ check: "rtk", status: "pass", detail: rtkVersion });
      } catch {
        checks.push({ check: "rtk", status: "warn", detail: "not found in PATH" });
      }

      try {
        const store = getStore();
        const stats = store.getStats();
        checks.push({ check: "content store", status: "pass", detail: `${stats.totalChunks} chunks, ${stats.totalSources} sources` });
      } catch (e) {
        checks.push({ check: "content store", status: "fail", detail: `${e instanceof Error ? e.message : String(e)}` });
      }

      const passed = checks.filter(c => c.status === "pass").length;
      const failed = checks.filter(c => c.status === "fail").length;
      const warned = checks.filter(c => c.status === "warn").length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ version: VERSION, platform: process.platform, node: process.version, summary: { passed, failed, warned }, checks }, null, 2),
        }],
      };
    }

    if (name === "ctx_purge") {
      initSessionDb(getProjectDir());
      const parsed = PurgeSchema.safeParse(args ?? {});
      if (parsed.success && parsed.data.sessionId) {
        deleteSession(parsed.data.sessionId);
        return { content: [{ type: "text", text: `Deleted session: ${parsed.data.sessionId}` }] };
      }
      const purged = cleanupOldSessions(parsed.success ? (parsed.data.daysOld ?? 0) : 0);
      return { content: [{ type: "text", text: `Purged ${purged} old sessions from ${getSessionDbPath()}` }] };
    }

    if (name === "ctx_session") {
      initSessionDb(getProjectDir());
      const sesId = (args as Record<string, unknown> | null)?.sessionId as string | undefined;
      const sessionId = sesId || getLatestSessionId();
      if (!sessionId) {
        return { content: [{ type: "text", text: "No session found. Run ctx_execute or another tool first to create a session." }], isError: true };
      }

      const analytics = querySessionAnalytics(sessionId);
      if (!analytics) {
        return { content: [{ type: "text", text: `Session ${sessionId} not found` }], isError: true };
      }

      const report = formatReport(analytics);

      // Build and store snapshot for resume injection
      const events = getEvents(sessionId, { limit: 1000 });
      if (events.length > 0) {
        const newCompactCount = analytics.compactCount + 1;
        incrementCompactCount(sessionId);
        const snapshot = buildResumeSnapshot(events, { compactCount: newCompactCount });
        if (snapshot) {
          upsertResume(sessionId, snapshot, events.length);
        }
      }

      return {
        content: [
          { type: "text", text: report },
          { type: "text", text: JSON.stringify(analytics, null, 2) },
        ],
      };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
});

export { server, executor };

async function main() {
  console.error("[mcp_ctx_tool] MCP server starting...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp_ctx_tool] MCP server connected");
}

main().catch((error) => {
  console.error("[mcp_ctx_tool] Fatal error:", error);
  process.exit(1);
});
