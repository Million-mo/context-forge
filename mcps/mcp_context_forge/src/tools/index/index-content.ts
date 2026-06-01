/**
 * ctx_index — index file or content into searchable store
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const IndexSchema = z.object({
  content: z.string().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
});

export { IndexSchema };

export const indexTool: ToolDefinition = {
  group: "index",
  name: "ctx_index",
  description: "Index file or content into searchable FTS5 store. Indexed content can be searched with ctx_content_search.",
  inputSchema: IndexSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { getStore, getProjectDir } = await import("../../services.js");
    const store = getStore() as { index(content: string, opts?: { source?: string }): Promise<unknown>; indexFile(filePath: string, opts?: { source?: string }): Promise<unknown> };

    const parsed = IndexSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    try {
      let result;
      if (parsed.data.path) {
        result = await store.indexFile(parsed.data.path, { source: parsed.data.source });
      } else if (parsed.data.content) {
        result = await store.index(parsed.data.content, { source: parsed.data.source });
      } else {
        return { content: [{ type: "text", text: "Provide either 'path' or 'content'" }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Index error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};
