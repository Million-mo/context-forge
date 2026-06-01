/**
 * ctx_summary_messages — get raw messages for a turn
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const SummaryMessagesSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number(),
});

export { SummaryMessagesSchema };

export const summaryMessagesTool: ToolDefinition = {
  group: "memory",
  name: "ctx_summary_messages",
  description: "Get raw messages for a specific turn (lossless recall)",
  inputSchema: SummaryMessagesSchema,
  featureFlag: "memory",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { getTurnMessages } = await import("../../services.js");

    const parsed = SummaryMessagesSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const messages = getTurnMessages(parsed.data.sessionId, parsed.data.turnIndex);
    return {
      content: [{ type: "text", text: JSON.stringify({ sessionId: parsed.data.sessionId, turnIndex: parsed.data.turnIndex, count: messages.length, messages }, null, 2) }],
    };
  },
};
