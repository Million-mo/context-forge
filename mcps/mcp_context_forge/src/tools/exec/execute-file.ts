/**
 * ctx_execute_file — sandboxed file execution
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const ExecuteFileSchema = z.object({
  path: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().optional(),
});

export { ExecuteFileSchema };

export const executeFileTool: ToolDefinition = {
  group: "exec",
  name: "ctx_execute_file",
  description: "Read and execute a script file with sandboxed environment. Path must be within project root.",
  inputSchema: ExecuteFileSchema,
  featureFlag: "execution",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args: unknown) => {
    const { getExecutor } = await import("../../services.js");
    const executor = getExecutor() as { executeFile(opts: { path: string; args?: string[]; env?: Record<string, string>; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> };

    const parsed = ExecuteFileSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const result = await executor.executeFile(parsed.data);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: result.exitCode !== 0 };
  },
};
