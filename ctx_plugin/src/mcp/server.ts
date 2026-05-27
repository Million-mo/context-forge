/**
 * MCP Server for ctx_plugin
 *
 * Provides sandboxed code execution and FTS5 search capabilities.
 * This is the main entry point for the MCP protocol communication.
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

// Server version
const VERSION = "0.3.0";

// Get project directory from environment or cwd
function getProjectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PROJECT_DIR || process.cwd();
}

// Create MCP server instance
const server = new McpServer(
  { name: "ctx_tool_mcp", version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  }
);

// Create executor instance
const executor = new PolyglotExecutor();

// Create content store (lazy initialization)
let contentStore: ContentStore | null = null;

function getStore(): ContentStore {
  if (!contentStore) {
    contentStore = new ContentStore(getProjectDir());
  }
  return contentStore;
}

// Register empty prompts/resources on the underlying server
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [],
}));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [],
}));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [],
}));

// Tool schemas using Zod
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

// Register tools
server.registerTool(
  "ctx_ping",
  {
    title: "Health Check",
    description: "Health check for ctx_plugin MCP server",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: "text", text: "pong" }],
  })
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

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text", text: JSON.stringify({ available, summary }, null, 2) }],
    };
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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (args.content) {
      const result = await store.index(args.content, { source: args.source });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    return {
      content: [{ type: "text", text: "Provide either 'path' or 'content'" }],
      isError: true,
    };
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

    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
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
    return {
      content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
    };
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
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
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
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
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
    const { initSessionDb, cleanupOldSessions, deleteSession, getSessionDbPath } = await import("../session-db.js");
    initSessionDb(getProjectDir());

    if (args.sessionId) {
      deleteSession(args.sessionId);
      return {
        content: [{ type: "text", text: `Deleted session: ${args.sessionId}` }],
      };
    }

    const purged = cleanupOldSessions(args.daysOld ?? 0);
    return {
      content: [{ type: "text", text: `Purged ${purged} old sessions from ${getSessionDbPath()}` }],
    };
  }
);

// Register tools list handler
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ctx_ping",
      description: "Health check for ctx_plugin MCP server",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ctx_execute",
      description: "Execute code in sandbox with multiple language support",
      inputSchema: {
        type: "object",
        properties: {
          language: {
            type: "string",
            enum: ["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir"],
          },
          code: { type: "string" },
          timeout: { type: "number" },
        },
        required: ["language", "code"],
      },
    },
    {
      name: "ctx_runtimes",
      description: "List available language runtimes",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ctx_index",
      description: "Index file or content into searchable store",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          path: { type: "string" },
          source: { type: "string" },
        },
      },
    },
    {
      name: "ctx_search",
      description: "Search indexed content with BM25 + trigram RRF fusion",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          source: { type: "string" },
          contentType: { type: "string", enum: ["code", "prose"] },
        },
        required: ["query"],
      },
    },
    {
      name: "ctx_stats",
      description: "Get content store statistics",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ctx_execute_file",
      description: "Read and execute a script file with sandboxed environment",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          args: { type: "array", items: { type: "string" } },
          env: { type: "object", additionalProperties: { type: "string" } },
          timeout: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "ctx_batch_execute",
      description: "Execute multiple code blocks sequentially or in parallel",
      inputSchema: {
        type: "object",
        properties: {
          commands: {
            type: "array",
            items: {
              type: "object",
              properties: {
                language: { type: "string" },
                code: { type: "string" },
              },
              required: ["language", "code"],
            },
          },
          sequential: { type: "boolean" },
          stopOnError: { type: "boolean" },
        },
        required: ["commands"],
      },
    },
    {
      name: "ctx_fetch_and_index",
      description: "Fetch web content and index it for search",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          source: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      name: "ctx_doctor",
      description: "Run system diagnostics for ctx_plugin installation",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "ctx_purge",
      description: "Clear session data from the SQLite store",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          daysOld: { type: "number" },
        },
      },
    },
  ],
}));

// Register call tool handler
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "ctx_ping") {
      return { content: [{ type: "text", text: "pong" }] };
    }

    if (name === "ctx_execute") {
      const parsed = ExecuteSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }

      const { language, code, timeout } = parsed.data;
      const result = await executor.execute({
        language,
        code,
        timeout: timeout ?? 30000,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "ctx_runtimes") {
      const runtimes = executor.runtimes;
      const available = getAvailableLanguages(runtimes);
      const summary = getRuntimeSummary(runtimes);
      return {
        content: [{ type: "text", text: JSON.stringify({ available, summary }, null, 2) }],
      };
    }

    if (name === "ctx_index") {
      const parsed = IndexSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }

      const store = getStore();
      if (parsed.data.path) {
        const result = await store.indexFile(parsed.data.path, { source: parsed.data.source });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      if (parsed.data.content) {
        const result = await store.index(parsed.data.content, { source: parsed.data.source });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: "Provide either 'path' or 'content'" }],
        isError: true,
      };
    }

    if (name === "ctx_search") {
      const parsed = SearchSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }

      const store = getStore();
      const results = store.search(parsed.data.query, parsed.data.limit ?? 10, {
        source: parsed.data.source,
        contentType: parsed.data.contentType,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }

    if (name === "ctx_stats") {
      const store = getStore();
      const stats = store.getStats();
      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
      };
    }

    if (name === "ctx_execute_file") {
      const parsed = ExecuteFileSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      const result = await executor.executeFile({
        path: parsed.data.path,
        args: parsed.data.args,
        env: parsed.data.env,
        timeout: parsed.data.timeout,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.exitCode !== 0,
      };
    }

    if (name === "ctx_batch_execute") {
      const parsed = BatchExecuteSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      const result = await executor.batchExecute({
        commands: parsed.data.commands,
        sequential: parsed.data.sequential,
        stopOnError: parsed.data.stopOnError,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "ctx_fetch_and_index") {
      const parsed = FetchAndIndexSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true,
        };
      }
      try {
        const response = await fetch(parsed.data.url, {
          headers: { "User-Agent": "ctx_plugin/1.0" },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `HTTP ${response.status}: ${response.statusText}` }],
            isError: true,
          };
        }
        const text = await response.text();
        const store = getStore();
        const indexResult = await store.index(text, { source: parsed.data.source ?? parsed.data.url });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              url: parsed.data.url,
              size: text.length,
              indexed: indexResult.totalChunks,
              sourceId: indexResult.sourceId,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
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
        checks.push({
          check: "content store",
          status: "pass",
          detail: `${stats.totalChunks} chunks, ${stats.totalSources} sources`,
        });
      } catch (e) {
        checks.push({
          check: "content store",
          status: "fail",
          detail: `${e instanceof Error ? e.message : String(e)}`,
        });
      }

      const passed = checks.filter(c => c.status === "pass").length;
      const failed = checks.filter(c => c.status === "fail").length;
      const warned = checks.filter(c => c.status === "warn").length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            version: VERSION,
            platform: process.platform,
            node: process.version,
            summary: { passed, failed, warned },
            checks,
          }, null, 2),
        }],
      };
    }

    if (name === "ctx_purge") {
      const { initSessionDb, cleanupOldSessions, deleteSession, getSessionDbPath } = await import("../session-db.js");
      initSessionDb(getProjectDir());
      const parsed = PurgeSchema.safeParse(args ?? {});

      if (parsed.success && parsed.data.sessionId) {
        deleteSession(parsed.data.sessionId);
        return { content: [{ type: "text", text: `Deleted session: ${parsed.data.sessionId}` }] };
      }

      const purged = cleanupOldSessions(parsed.success ? (parsed.data.daysOld ?? 0) : 0);
      return {
        content: [{ type: "text", text: `Purged ${purged} old sessions from ${getSessionDbPath()}` }],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

// Export for testing
export { server, executor };

// Main entry point
async function main() {
  console.error("[ctx_tool_mcp] MCP server starting...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ctx_tool_mcp] MCP server connected");
}

main().catch((error) => {
  console.error("[ctx_plugin] Fatal error:", error);
  process.exit(1);
});
