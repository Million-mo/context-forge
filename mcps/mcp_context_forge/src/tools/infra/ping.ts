/**
 * ctx_ping — health check tool
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

export const PingSchema = z.object({});

export const pingTool: ToolDefinition = {
  group: "infra",
  name: "ctx_ping",
  description: "Health check for mcp_context_forge",
  inputSchema: PingSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async () => {
    const registry = (globalThis as Record<string, unknown>).__ctxRegistry as { getFeatures(): { execution: boolean; memory: boolean } } | undefined;
    const features = registry?.getFeatures() ?? { execution: true, memory: true };

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          pong: true,
          version: "0.5.0",
          features,
        }, null, 2),
      }],
    };
  },
};
