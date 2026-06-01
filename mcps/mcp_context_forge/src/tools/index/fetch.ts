/**
 * ctx_fetch — fetch URL and index it
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const FetchSchema = z.object({
  url: z.string(),
  source: z.string().optional(),
});

export { FetchSchema };

export const fetchTool: ToolDefinition = {
  group: "index",
  name: "ctx_fetch",
  description: "Fetch web content and index it for search",
  inputSchema: FetchSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args: unknown) => {
    const { getStore } = await import("../../services.js");
    const store = getStore() as { index(content: string, opts?: { source?: string }): Promise<unknown> };

    const parsed = FetchSchema.safeParse(args);
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
      const indexResult = await store.index(text, { source: parsed.data.source ?? parsed.data.url });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ url: parsed.data.url, size: text.length, indexed: (indexResult as { totalChunks?: number }).totalChunks ?? 0 }, null, 2),
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Fetch failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  },
};
