/**
 * ctx_execute — sandboxed code execution
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";
import type { Language } from "../../types.js";

const ExecuteSchema = z.object({
  language: z.enum(["javascript", "typescript", "python", "shell", "ruby", "go", "rust", "php", "perl", "r", "elixir"] as const satisfies readonly Language[]),
  code: z.string(),
  timeout: z.number().optional(),
});

export { ExecuteSchema };

export const executeTool: ToolDefinition = {
  group: "exec",
  name: "ctx_execute",
  description: "Execute code in sandbox with multiple language support (11 languages, 100MB output cap). Use this instead of Bash for running scripts.",
  inputSchema: ExecuteSchema,
  featureFlag: "execution",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args: unknown) => {
    const { getExecutor, getProjectDir, initSessionDb, getLatestSessionId, ensureSession, insertSessionEvent } = await import("../../services.js");
    const { extractToolCall } = await import("../infra/classifier.js");

    const parsed = ExecuteSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }], isError: true };
    }

    const { language, code, timeout } = parsed.data;
    const executor = getExecutor() as { execute(opts: { language: Language; code: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> };
    const result = await executor.execute({ language, code, timeout: timeout ?? 30000 });

    // Record event
    try {
      initSessionDb(getProjectDir());
      const sid = getLatestSessionId() ?? `session-${Date.now()}`;
      ensureSession(sid, getProjectDir());
      const events = extractToolCall(sid, { toolName: "ctx_execute", toolInput: { language, code }, toolResponse: JSON.stringify(result), isError: result.exitCode !== 0 });
      for (const ev of events) insertSessionEvent(ev);
    } catch { /* best-effort */ }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: result.exitCode !== 0,
    };
  },
};
