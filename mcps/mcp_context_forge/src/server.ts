/**
 * Context Forge — Unified MCP Server
 *
 * Combines mcp_ctx_tool (execution + content indexing) and
 * mcp_ctx_summary (session memory + recall) into a single MCP.
 *
 * Tool groups:
 *   exec/   — sandboxed code execution
 *   index/  — FTS5 content indexing & search
 *   memory/ — session summaries, recall, analytics
 *   infra/  — health checks, diagnostics, cleanup
 *
 * Feature flags (env vars):
 *   CTX_DISABLE_EXECUTION=1   → skip exec tools
 *   CTX_DISABLE_MEMORY=1      → skip memory tools (summaries.db not required)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  loadLLMConfig,
  createLLMClient,
  type OpenAIClient,
} from "@context-forge/shared-types";
import { buildRecallPrompt } from "../../mcp_ctx_summary/src/recall-prompts.js";

// ── Execution & indexing (from mcp_ctx_tool) ──────────────────────────────────

import { PolyglotExecutor } from "../../mcp_ctx_tool/src/executor.js";
import {
  getAvailableLanguages,
  getRuntimeSummary,
  getRuntimeInfo,
} from "../../mcp_ctx_tool/src/runtime.js";
import { ContentStore } from "../../mcp_ctx_tool/src/store.js";
import {
  initSessionDb,
  cleanupOldSessions,
  deleteSession,
  getSessionDbPath,
  ensureSession,
  getLatestSessionId,
  getEvents,
  insertEvent,
  upsertResume,
  incrementCompactCount,
} from "../../mcp_ctx_tool/src/session-db.js";
import { extractToolCall, type ToolCallInfo } from "../../mcp_ctx_tool/src/session/extract.js";
import { buildResumeSnapshot } from "../../mcp_ctx_tool/src/session/snapshot.js";
import {
  querySessionAnalytics,
  formatReport,
} from "../../mcp_ctx_tool/src/session/analytics.js";

// ── Memory queries (extracted from mcp_ctx_summary) ───────────────────────────

import {
  searchSummaries,
  listBySession,
  getSummary,
  getMessages,
  getMessagesByRange,
  getSummaryStats,
} from "./summary-queries.js";

// ═══════════════════════════════════════════════════════════════════
// Feature flags
// ═══════════════════════════════════════════════════════════════════

const FEATURES = {
  execution: !process.env.CTX_DISABLE_EXECUTION,
  memory: !process.env.CTX_DISABLE_MEMORY,
};

const VERSION = "0.4.0";

// ═══════════════════════════════════════════════════════════════════
// LLM client for recall
// ═══════════════════════════════════════════════════════════════════

const llmConfig = loadLLMConfig();
const recallLLM: OpenAIClient | null = createLLMClient(llmConfig);

// ═══════════════════════════════════════════════════════════════════
// Lazy singletons
// ═══════════════════════════════════════════════════════════════════

let executor: PolyglotExecutor | null = null;

function getExecutor(): PolyglotExecutor {
  if (!executor) {
    executor = new PolyglotExecutor();
  }
  return executor;
}

let contentStore: ContentStore | null = null;

function getStore(): ContentStore {
  if (!contentStore) {
    contentStore = new ContentStore(getProjectDir());
  }
  return contentStore;
}

function getProjectDir(): string {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.PROJECT_DIR ||
    process.cwd()
  );
}

// ═══════════════════════════════════════════════════════════════════
// Session event recording (best-effort)
// ═══════════════════════════════════════════════════════════════════

function recordToolEvent(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: string,
  isError: boolean,
): void {
  try {
    const projectDir = getProjectDir();
    initSessionDb(projectDir);
    const existingSid = getLatestSessionId();
    const sid = existingSid ?? `session-${Date.now()}`;
    if (!existingSid) {
      ensureSession(sid, projectDir);
    }
    const call: ToolCallInfo = { toolName, toolInput, toolResponse, isError };
    const events = extractToolCall(sid, call, projectDir);
    for (const ev of events) {
      insertEvent(ev);
    }
  } catch {
    // best-effort
  }
}

// ═══════════════════════════════════════════════════════════════════
// Recall helper
// ═══════════════════════════════════════════════════════════════════

async function performRecall(
  query: string,
  sessionId: string | undefined,
  limit: number,
): Promise<{
  query: string;
  totalFound: number;
  recalls: Array<{
    turnIndex: number;
    sessionId: string;
    overview: string;
    intent: string;
    outcome: string;
    confidence: number;
    recall: string;
  }>;
}> {
  const summaries = searchSummaries(query, limit, sessionId);
  if (summaries.length === 0) {
    return { query, totalFound: 0, recalls: [] };
  }

  const recalls: Array<{
    turnIndex: number;
    sessionId: string;
    overview: string;
    intent: string;
    outcome: string;
    confidence: number;
    recall: string;
  }> = [];

  for (const summary of summaries) {
    const effectiveSessionId = summary.sessionId || sessionId;
    let messages = effectiveSessionId
      ? getMessages(effectiveSessionId, summary.turnIndex)
      : [];

    if (messages.length === 0 && summary.startMsgId && summary.endMsgId) {
      messages = getMessagesByRange(summary.startMsgId, summary.endMsgId);
    }

    if (!recallLLM) {
      recalls.push({
        turnIndex: summary.turnIndex,
        sessionId: summary.sessionId || sessionId || "",
        overview: summary.overview,
        intent: summary.intent,
        outcome: summary.outcome,
        confidence: summary.confidence,
        recall: `LLM not available. Messages: ${messages.map((m) => `[${m.role}] ${m.content.slice(0, 200)}`).join(" | ")}`,
      });
      continue;
    }

    try {
      const prompt = buildRecallPrompt({ query, summary, messages });
      const recall = await recallLLM.generate(prompt);
      recalls.push({
        turnIndex: summary.turnIndex,
        sessionId: summary.sessionId || sessionId || "",
        overview: summary.overview,
        intent: summary.intent,
        outcome: summary.outcome,
        confidence: summary.confidence,
        recall: recall.trim(),
      });
    } catch (err) {
      console.error("[recall] LLM error:", err);
      recalls.push({
        turnIndex: summary.turnIndex,
        sessionId: summary.sessionId || sessionId || "",
        overview: summary.overview,
        intent: summary.intent,
        outcome: summary.outcome,
        confidence: summary.confidence,
        recall: `Recall generation failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { query, totalFound: recalls.length, recalls };
}

// ═══════════════════════════════════════════════════════════════════
// MCP Server
// ═══════════════════════════════════════════════════════════════════

const server = new McpServer(
  { name: "mcp_context_forge", version: VERSION },
  { capabilities: { tools: {} } },
);

// ═══════════════════════════════════════════════════════════════════
// Tool schema definitions
// ═══════════════════════════════════════════════════════════════════

const ExecuteSchema = z.object({
  language: z.enum([
    "javascript", "typescript", "python", "shell",
    "ruby", "go", "rust", "php", "perl", "r", "elixir",
  ]),
  code: z.string(),
  timeout: z.number().optional(),
});

const ExecuteFileSchema = z.object({
  path: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional(),
});

const BatchExecuteSchema = z.object({
  commands: z.array(
    z.object({ language: z.string(), code: z.string() }),
  ),
  sequential: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
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

const FetchAndIndexSchema = z.object({
  url: z.string(),
  source: z.string().optional(),
});

const PurgeSchema = z.object({
  sessionId: z.string().optional(),
  daysOld: z.number().optional(),
});

const RecallSchema = z.object({
  query: z.string().describe("Natural language query for recall"),
  sessionId: z.string().optional().describe("Filter by session ID"),
  limit: z.number().optional().default(3).describe("Max results"),
});

const SummarySearchSchema = z.object({
  query: z.string(),
  limit: z.number().optional().default(5),
  sessionId: z.string().optional(),
});

// ═══════════════════════════════════════════════════════════════════
// Tool list
// ═══════════════════════════════════════════════════════════════════

server.server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: Record<string, boolean>;
  }> = [];

  // ── infra ──────────────────────────────────────────────────────────

  tools.push(
    {
      name: "ctx_ping",
      description: "Health check for mcp_context_forge",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "ctx_doctor",
      description: "Run system diagnostics: runtimes, content store, DB status",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "ctx_purge",
      description: "Clear session data from the SQLite event store",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string", description: "Specific session to delete" },
          daysOld: { type: "number", description: "Delete sessions older than N days" },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "summary_health",
      description: "Database statistics for summaries.db (total summaries, sessions, messages, DB size) and LLM recall status",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  );

  // ── exec ───────────────────────────────────────────────────────────

  if (FEATURES.execution) {
    tools.push(
      {
        name: "ctx_execute",
        description: "Execute code in sandbox with multiple language support (11 languages, 100MB output cap). Use this instead of Bash for running scripts.",
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
      {
        name: "ctx_execute_file",
        description: "Read and execute a script file with sandboxed environment. Path must be within project root.",
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
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
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
                properties: { language: { type: "string" }, code: { type: "string" } },
                required: ["language", "code"],
              },
            },
            sequential: { type: "boolean" },
            stopOnError: { type: "boolean" },
          },
          required: ["commands"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      {
        name: "ctx_runtimes",
        description: "List available language runtimes and their versions",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    );
  }

  // ── index ──────────────────────────────────────────────────────────

  tools.push(
    {
      name: "ctx_index",
      description: "Index file or content into searchable FTS5 store. Indexed content can be searched with ctx_search.",
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" }, path: { type: "string" }, source: { type: "string" } },
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "ctx_search",
      description: "BM25 + trigram RRF fusion search across indexed content (files, web pages). For searching conversation summaries, use summary_search.",
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
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "ctx_fetch_and_index",
      description: "Fetch web content and index it for search",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, source: { type: "string" } },
        required: ["url"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: "ctx_stats",
      description: "Get content store statistics (total sources, chunks, DB size)",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  );

  // ── memory ─────────────────────────────────────────────────────────

  if (FEATURES.memory) {
    tools.push(
      {
        name: "summary_recall",
        description: "Intent-driven recall: search conversation history by natural language query, returns LLM-generated context summary. Use this to answer 'what did we do earlier?'",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language query for recall" },
            sessionId: { type: "string", description: "Filter by session ID" },
            limit: { type: "number", description: "Max results", default: 3 },
          },
          required: ["query"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      {
        name: "summary_search",
        description: "FTS5 full-text search across turn summaries. For searching indexed files/content, use ctx_search.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", default: 5 },
            sessionId: { type: "string" },
          },
          required: ["query"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "summary_list",
        description: "List all summaries for a specific session in turn order",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" } },
          required: ["sessionId"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "summary_get",
        description: "Get a single turn summary by session ID and turn index",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" }, turnIndex: { type: "number" } },
          required: ["sessionId", "turnIndex"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "summary_messages",
        description: "Get raw messages for a specific turn (lossless recall)",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" }, turnIndex: { type: "number" } },
          required: ["sessionId", "turnIndex"],
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      {
        name: "ctx_session",
        description: "Session analytics: events tracked, tool call stats, category breakdown, and context savings report. Use this for structured 'what happened' overview.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string", description: "Optional session ID (defaults to latest)" } },
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
    );
  }

  return { tools };
});

// ═══════════════════════════════════════════════════════════════════
// Tool call handler
// ═══════════════════════════════════════════════════════════════════

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── infra ────────────────────────────────────────────────────────

    if (name === "ctx_ping") {
      const features = {
        execution: FEATURES.execution,
        memory: FEATURES.memory,
      };
      return {
        content: [{ type: "text", text: JSON.stringify({ pong: true, version: VERSION, features }, null, 2) }],
      };
    }

    if (name === "ctx_doctor") {
      const checks: Array<{ check: string; status: string; detail: string }> = [];
      const runtimes = getExecutor().runtimes;

      for (const lang of ["javascript", "typescript", "python", "shell"] as const) {
        const rt = getRuntimeInfo(runtimes, lang);
        checks.push({
          check: `${lang} runtime`,
          status: rt.available ? "pass" : "fail",
          detail: rt.available ? `${rt.command} (${rt.version})` : "not found",
        });
      }

      try {
        const store = getStore();
        const stats = store.getStats();
        checks.push({ check: "content store", status: "pass", detail: `${stats.totalChunks} chunks, ${stats.totalSources} sources` });
      } catch (e) {
        checks.push({ check: "content store", status: "fail", detail: `${e instanceof Error ? e.message : String(e)}` });
      }

      if (FEATURES.memory) {
        try {
          const s = getSummaryStats();
          checks.push({ check: "summaries DB", status: "pass", detail: `${s.totalSummaries} summaries, ${s.totalSessions} sessions` });
        } catch (e) {
          checks.push({ check: "summaries DB", status: "warn", detail: `${e instanceof Error ? e.message : String(e)}` });
        }
      }

      checks.push({ check: "recall LLM", status: recallLLM ? "pass" : "warn", detail: recallLLM ? "enabled" : "no API key" });

      const passed = checks.filter((c) => c.status === "pass").length;
      const failed = checks.filter((c) => c.status === "fail").length;
      const warned = checks.filter((c) => c.status === "warn").length;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { version: VERSION, platform: process.platform, node: process.version, summary: { passed, failed, warned }, features: FEATURES, checks },
              null, 2,
            ),
          },
        ],
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

    if (name === "summary_health") {
      if (!FEATURES.memory) {
        return { content: [{ type: "text", text: "Memory feature disabled (CTX_DISABLE_MEMORY=1)" }], isError: true };
      }
      try {
        const stats = getSummaryStats();
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "ok", ...stats, recallEnabled: !!recallLLM }, null, 2) }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `DB not ready: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }

    // ── exec ────────────────────────────────────────────────────────

    if (name === "ctx_execute") {
      if (!FEATURES.execution) {
        return { content: [{ type: "text", text: "Execution feature disabled (CTX_DISABLE_EXECUTION=1)" }], isError: true };
      }
      const parsed = ExecuteSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const { language, code, timeout } = parsed.data;
      const result = await getExecutor().execute({ language, code, timeout: timeout ?? 30000 });
      recordToolEvent("ctx_execute", { language, code }, JSON.stringify(result), result.exitCode !== 0);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "ctx_execute_file") {
      if (!FEATURES.execution) {
        return { content: [{ type: "text", text: "Execution feature disabled" }], isError: true };
      }
      const parsed = ExecuteFileSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const result = await getExecutor().executeFile({
        path: parsed.data.path,
        args: parsed.data.args,
        env: parsed.data.env,
        timeout: parsed.data.timeout,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.exitCode !== 0 };
    }

    if (name === "ctx_batch_execute") {
      if (!FEATURES.execution) {
        return { content: [{ type: "text", text: "Execution feature disabled" }], isError: true };
      }
      const parsed = BatchExecuteSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const result = await getExecutor().batchExecute({
        commands: parsed.data.commands as Array<{ language: string; code: string }>,
        sequential: parsed.data.sequential,
        stopOnError: parsed.data.stopOnError,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "ctx_runtimes") {
      const runtimes = getExecutor().runtimes;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { available: getAvailableLanguages(runtimes), summary: getRuntimeSummary(runtimes) },
              null, 2,
            ),
          },
        ],
      };
    }

    // ── index ───────────────────────────────────────────────────────

    if (name === "ctx_index") {
      const parsed = IndexSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const store = getStore();
      if (parsed.data.path) {
        const result = await store.indexFile(parsed.data.path, { source: parsed.data.source });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (parsed.data.content) {
        const result = await store.index(parsed.data.content, { source: parsed.data.source });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      return { content: [{ type: "text", text: "Provide either 'path' or 'content'" }], isError: true };
    }

    if (name === "ctx_search") {
      const parsed = SearchSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      const results = getStore().search(parsed.data.query, parsed.data.limit ?? 10, {
        source: parsed.data.source,
        contentType: parsed.data.contentType,
      });
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    if (name === "ctx_fetch_and_index") {
      const parsed = FetchAndIndexSchema.safeParse(args);
      if (!parsed.success) {
        return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
      }
      try {
        const response = await fetch(parsed.data.url, {
          headers: { "User-Agent": "mcp_context_forge/1.0" },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          return { content: [{ type: "text", text: `HTTP ${response.status}: ${response.statusText}` }], isError: true };
        }
        const text = await response.text();
        const store = getStore();
        const indexResult = await store.index(text, { source: parsed.data.source ?? parsed.data.url });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { url: parsed.data.url, size: text.length, indexed: indexResult.totalChunks, sourceId: indexResult.sourceId },
                null, 2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }

    if (name === "ctx_stats") {
      const stats = getStore().getStats();
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    }

    // ── memory ──────────────────────────────────────────────────────

    if (name === "summary_recall") {
      if (!FEATURES.memory) {
        return { content: [{ type: "text", text: "Memory feature disabled (CTX_DISABLE_MEMORY=1)" }], isError: true };
      }
      const { query, sessionId, limit = 3 } = RecallSchema.parse(args);
      const result = await performRecall(query, sessionId, limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    if (name === "summary_search") {
      if (!FEATURES.memory) {
        return { content: [{ type: "text", text: "Memory feature disabled" }], isError: true };
      }
      const { query, limit = 5, sessionId } = SummarySearchSchema.parse(args);
      const results = searchSummaries(query, limit, sessionId);
      return {
        content: [{ type: "text", text: JSON.stringify({ query, count: results.length, results }, null, 2) }],
      };
    }

    if (name === "summary_list") {
      if (!FEATURES.memory) {
        return { content: [{ type: "text", text: "Memory feature disabled" }], isError: true };
      }
      const { sessionId } = z.object({ sessionId: z.string() }).parse(args);
      const results = listBySession(sessionId);
      return {
        content: [{ type: "text", text: JSON.stringify({ sessionId, count: results.length, results }, null, 2) }],
      };
    }

    if (name === "summary_get") {
      if (!FEATURES.memory) {
        return { content: [{ type: "text", text: "Memory feature disabled" }], isError: true };
      }
      const { sessionId, turnIndex } = z
        .object({ sessionId: z.string(), turnIndex: z.number() })
        .parse(args);
      const summary = getSummary(sessionId, turnIndex);
      if (!summary) {
        return {
          content: [{ type: "text", text: `Summary not found: session=${sessionId} turn=${turnIndex}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
    }

    if (name === "summary_messages") {
      if (!FEATURES.memory) {
        return { content: [{ type: "text", text: "Memory feature disabled" }], isError: true };
      }
      const { sessionId, turnIndex } = z
        .object({ sessionId: z.string(), turnIndex: z.number() })
        .parse(args);
      const messages = getMessages(sessionId, turnIndex);
      return {
        content: [{ type: "text", text: JSON.stringify({ sessionId, turnIndex, count: messages.length, messages }, null, 2) }],
      };
    }

    if (name === "ctx_session") {
      initSessionDb(getProjectDir());
      const sesId = (args as Record<string, unknown> | null)?.sessionId as string | undefined;
      const sessionId = sesId || getLatestSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text", text: "No session found. Run ctx_execute or another tool first to create a session." }],
          isError: true,
        };
      }
      const analytics = querySessionAnalytics(sessionId);
      if (!analytics) {
        return { content: [{ type: "text", text: `Session ${sessionId} not found` }], isError: true };
      }
      const report = formatReport(analytics);

      // Build resume snapshot
      const events = getEvents(sessionId, { limit: 1000 });
      if (events.length > 0) {
        incrementCompactCount(sessionId);
        const snapshot = buildResumeSnapshot(events, { compactCount: analytics.compactCount + 1 });
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
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

// ═══════════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.error(`[mcp_context_forge] v${VERSION} starting...`);
  console.error(`[mcp_context_forge] Features: execution=${FEATURES.execution}, memory=${FEATURES.memory}`);
  console.error(`[mcp_context_forge] Recall LLM: ${recallLLM ? "enabled" : "disabled (no API key)"}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp_context_forge] Connected");
}

main().catch((error) => {
  console.error("[mcp_context_forge] Fatal:", error);
  process.exit(1);
});
