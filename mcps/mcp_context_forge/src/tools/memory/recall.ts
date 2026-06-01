/**
 * ctx_recall — intent-driven recall across conversation history
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const RecallSchema = z.object({
  query: z.string().describe("Natural language query for recall"),
  sessionId: z.string().optional().describe("Filter by session ID"),
  limit: z.number().optional().default(3).describe("Max results"),
});

export { RecallSchema };

export const recallTool: ToolDefinition = {
  group: "memory",
  name: "ctx_recall",
  description: "Intent-driven recall: search conversation history by natural language query, returns LLM-generated context summary. Use this to answer 'what did we do earlier?'",
  inputSchema: RecallSchema,
  featureFlag: "memory",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args: unknown) => {
    const { searchSummaries, getTurnMessages, getRecallLLM } = await import("../../services.js");

    const parsed = RecallSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const { query, sessionId, limit = 3 } = parsed.data;
    const summaries = searchSummaries(query, limit, sessionId);

    if (summaries.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({ query, totalFound: 0, recalls: [] }, null, 2) }] };
    }

    const recallLLM = getRecallLLM();
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
      const messages = effectiveSessionId ? getTurnMessages(effectiveSessionId, summary.turnIndex) : [];

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
        const recallText = await recallLLM.generate(prompt);
        recalls.push({
          turnIndex: summary.turnIndex,
          sessionId: summary.sessionId || sessionId || "",
          overview: summary.overview,
          intent: summary.intent,
          outcome: summary.outcome,
          confidence: summary.confidence,
          recall: recallText.trim(),
        });
      } catch (err) {
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

    return { content: [{ type: "text", text: JSON.stringify({ query, totalFound: recalls.length, recalls }, null, 2) }] };
  },
};

function buildRecallPrompt(params: {
  query: string;
  summary: { intent: string; outcome: string; overview: string; confidence: number; actions_json?: string; artifacts_json?: string };
  messages: Array<{ role: string; content: string; toolCalls?: unknown }>;
}): string {
  const { query, summary, messages } = params;
  const conversationText = messages.map((msg, idx) => {
    let header = `[${idx}] ${msg.role.toUpperCase()}`;
    if (msg.toolCalls) {
      const calls = msg.toolCalls as Array<{ name: string }>;
      header += ` (tools: ${calls.map((t) => t.name).join(", ")})`;
    }
    let body = msg.content;
    return `${header}\n${body}`;
  }).join("\n\n---\n\n");

  return `You are a memory recall assistant. Given a conversation turn and a query, recall the most relevant information that answers the user's question.

QUERY: "${query}"

CONTEXT:
- Intent: ${summary.intent}
- Outcome: ${summary.outcome}
- Overview: ${summary.overview}

CONVERSATION:
${conversationText}

---

Recall (output directly to answer the query):`;
}
