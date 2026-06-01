/**
 * ctx_runtimes — list available language runtimes
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const RuntimesSchema = z.object({});

export { RuntimesSchema };

export const runtimesTool: ToolDefinition = {
  group: "exec",
  name: "ctx_runtimes",
  description: "List available language runtimes and their versions",
  inputSchema: RuntimesSchema,
  featureFlag: "execution",
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async () => {
    const { getRuntimes } = await import("../../services.js");
    const { getRuntimeInfo } = await import("../../services.js");
    const runtimes = getRuntimes();

    const available: string[] = [];
    const summaryLines: string[] = [];

    for (const [lang, cmd] of Object.entries(runtimes)) {
      if (cmd) {
        available.push(lang);
        const info = getRuntimeInfo(lang as Parameters<typeof getRuntimeInfo>[0]);
        summaryLines.push(`  ${lang}: ${cmd} (${info.version})`);
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ available, summary: summaryLines.join("\n") }, null, 2),
      }],
    };
  },
};
