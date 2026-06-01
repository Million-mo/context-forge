/**
 * ctx_health — database statistics tool
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

export const HealthSchema = z.object({});

export const healthTool: ToolDefinition = {
  group: "infra",
  name: "ctx_health",
  description: "Database statistics for summaries.db and LLM recall status",
  inputSchema: HealthSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async () => {
    const { getSummaryStats, getRecallLLM } = await import("../../services.js");
    const registry = (globalThis as Record<string, unknown>).__ctxRegistry as { getFeatures(): { execution: boolean; memory: boolean } } | undefined;
    const features = registry?.getFeatures() ?? { execution: true, memory: true };

    if (!features.memory) {
      return { content: [{ type: "text", text: "Memory feature disabled (CTX_DISABLE_MEMORY=1)" }], isError: true };
    }

    try {
      const stats = getSummaryStats();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "ok", ...stats, recallEnabled: !!getRecallLLM() }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `DB not ready: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};
