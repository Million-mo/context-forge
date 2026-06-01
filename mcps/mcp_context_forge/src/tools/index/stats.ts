/**
 * ctx_content_stats — content store statistics
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const StatsSchema = z.object({});

export { StatsSchema };

export const statsTool: ToolDefinition = {
  group: "index",
  name: "ctx_content_stats",
  description: "Get content store statistics (total sources, chunks, DB size)",
  inputSchema: StatsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async () => {
    const { getStore } = await import("../../services.js");
    const store = getStore() as { getStats(): unknown };
    const stats = store.getStats();
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
  },
};
