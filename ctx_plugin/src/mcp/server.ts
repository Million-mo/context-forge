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
import { getAvailableLanguages, getRuntimeSummary } from "./runtime.js";
import { ContentStore } from "./store.js";

// Server version
const VERSION = "0.1.0";

// Get project directory from environment or cwd
function getProjectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.env.PROJECT_DIR || process.cwd();
}

// Create MCP server instance
const server = new McpServer(
  { name: "ctx_plugin", version: VERSION },
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
  console.error("[ctx_plugin] MCP server starting...");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ctx_plugin] MCP server connected");
}

main().catch((error) => {
  console.error("[ctx_plugin] Fatal error:", error);
  process.exit(1);
});
