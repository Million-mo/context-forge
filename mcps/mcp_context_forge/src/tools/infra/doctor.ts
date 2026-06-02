/**
 * ctx_doctor — system diagnostics tool
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";
import type { StoreStats } from "../../types.js";

export const DoctorSchema = z.object({});

export const doctorTool: ToolDefinition = {
  group: "infra",
  name: "ctx_doctor",
  description: "Run system diagnostics: runtimes, content store, DB status",
  inputSchema: DoctorSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async () => {
    const { getRuntimes, getRuntimeInfo } = await import("../../services.js");

    const checks: Array<{ check: string; status: string; detail: string }> = [];
    const version = "0.5.0";

    // Runtime checks
    const runtimes = getRuntimes();
    for (const lang of ["javascript", "typescript", "python", "shell"] as const) {
      const rt = getRuntimeInfo(lang);
      checks.push({
        check: `${lang} runtime`,
        status: rt.available ? "pass" : "fail",
        detail: rt.available ? `${rt.command} (${rt.version})` : "not found",
      });
    }

    // Content store check
    try {
      const store = (globalThis as Record<string, unknown>).__ctxStore as { getStats(): StoreStats } | undefined;
      if (store) {
        const stats = store.getStats();
        checks.push({ check: "content store", status: "pass", detail: `${stats.totalChunks} chunks, ${stats.totalSources} sources` });
      } else {
        checks.push({ check: "content store", status: "warn", detail: "not initialized" });
      }
    } catch (e) {
      checks.push({ check: "content store", status: "fail", detail: `${e instanceof Error ? e.message : String(e)}` });
    }

    const passed = checks.filter((c) => c.status === "pass").length;
    const failed = checks.filter((c) => c.status === "fail").length;
    const warned = checks.filter((c) => c.status === "warn").length;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          version,
          platform: process.platform,
          node: process.version,
          summary: { passed, failed, warned },
          checks,
        }, null, 2),
      }],
    };
  },
};
