/**
 * ctx_content_search — BM25 + trigram RRF fusion search
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const SearchSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
  source: z.string().optional(),
  contentType: z.enum(["code", "prose"]).optional(),
});

export { SearchSchema };

export const searchTool: ToolDefinition = {
  group: "index",
  name: "ctx_content_search",
  description: "BM25 + trigram RRF fusion search across indexed content. For searching conversation summaries, use ctx_summary_search.",
  inputSchema: SearchSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { getStore } = await import("../../services.js");
    const store = getStore() as { search(query: string, limit?: number, opts?: { source?: string; contentType?: "code" | "prose" }): unknown };

    const parsed = SearchSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const results = store.search(parsed.data.query, parsed.data.limit ?? 10, {
      source: parsed.data.source,
      contentType: parsed.data.contentType,
    });

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  },
};
