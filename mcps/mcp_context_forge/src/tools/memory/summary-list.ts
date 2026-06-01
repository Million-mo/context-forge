/**
 * ctx_summary_list — list summaries by session
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const SummaryListSchema = z.object({
  sessionId: z.string(),
});

export { SummaryListSchema };

export const summaryListTool: ToolDefinition = {
  group: "memory",
  name: "ctx_summary_list",
  description: "List all summaries for a specific session in turn order",
  inputSchema: SummaryListSchema,
  featureFlag: "memory",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { listSummariesBySession } = await import("../../services.js");

    const parsed = SummaryListSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const results = listSummariesBySession(parsed.data.sessionId);
    return {
      content: [{ type: "text", text: JSON.stringify({ sessionId: parsed.data.sessionId, count: results.length, results }, null, 2) }],
    };
  },
};
