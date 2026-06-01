/**
 * ctx_summary_get — get a single turn summary
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const SummaryGetSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number(),
});

export { SummaryGetSchema };

export const summaryGetTool: ToolDefinition = {
  group: "memory",
  name: "ctx_summary_get",
  description: "Get a single turn summary by session ID and turn index",
  inputSchema: SummaryGetSchema,
  featureFlag: "memory",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { getSummary } = await import("../../services.js");

    const parsed = SummaryGetSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const summary = getSummary(parsed.data.sessionId, parsed.data.turnIndex);
    if (!summary) {
      return {
        content: [{ type: "text", text: `Summary not found: session=${parsed.data.sessionId} turn=${parsed.data.turnIndex}` }],
        isError: true,
      };
    }

    return { content: [{ type: "text", text: JSON.stringify({ summary }, null, 2) }] };
  },
};
