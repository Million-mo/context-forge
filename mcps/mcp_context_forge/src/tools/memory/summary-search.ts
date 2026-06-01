/**
 * ctx_summary_search — FTS5 search across turn summaries
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const SummarySearchSchema = z.object({
  query: z.string(),
  limit: z.number().optional().default(5),
  sessionId: z.string().optional(),
});

export { SummarySearchSchema };

export const summarySearchTool: ToolDefinition = {
  group: "memory",
  name: "ctx_summary_search",
  description: "FTS5 full-text search across turn summaries. For searching indexed files/content, use ctx_content_search.",
  inputSchema: SummarySearchSchema,
  featureFlag: "memory",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { searchSummaries } = await import("../../services.js");

    const parsed = SummarySearchSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const { query, limit = 5, sessionId } = parsed.data;
    const results = searchSummaries(query, limit, sessionId);

    return {
      content: [{ type: "text", text: JSON.stringify({ query, count: results.length, results }, null, 2) }],
    };
  },
};
