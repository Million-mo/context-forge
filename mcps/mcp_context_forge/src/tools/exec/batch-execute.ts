/**
 * ctx_batch_execute — parallel/sequential multi-block execution
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";
import type { Language } from "../../types.js";

const BatchExecuteSchema = z.object({
  commands: z.array(z.object({ language: z.string(), code: z.string() })),
  sequential: z.boolean().optional(),
  stopOnError: z.boolean().optional(),
});

export { BatchExecuteSchema };

export const batchExecuteTool: ToolDefinition = {
  group: "exec",
  name: "ctx_batch_execute",
  description: "Execute multiple code blocks sequentially or in parallel",
  inputSchema: BatchExecuteSchema,
  featureFlag: "execution",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args: unknown) => {
    const { getExecutor } = await import("../../services.js");
    const executor = getExecutor() as { batchExecute(opts: { commands: Array<{ language: Language; code: string }>; sequential?: boolean; stopOnError?: boolean }): Promise<{ results: Array<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>; totalTime: number }> };

    const parsed = BatchExecuteSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const result = await executor.batchExecute({
      commands: parsed.data.commands as Array<{ language: Language; code: string }>,
      sequential: parsed.data.sequential,
      stopOnError: parsed.data.stopOnError,
    });

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};
