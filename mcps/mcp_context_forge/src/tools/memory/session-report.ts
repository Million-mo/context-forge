/**
 * ctx_session — session analytics and resume snapshot
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

const SessionSchema = z.object({
  sessionId: z.string().optional(),
});

export { SessionSchema };

export const sessionTool: ToolDefinition = {
  group: "memory",
  name: "ctx_session",
  description: "Session analytics: events tracked, tool call stats, category breakdown, and context savings report.",
  inputSchema: SessionSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const {
      initSessionDb, getLatestSessionId, getSessionMeta,
      getSessionEvents, getToolCallStats, getEventCount,
      incrementCompactCount, upsertResume, buildResumeSnapshotFromEvents,
    } = await import("../../services.js");

    initSessionDb();

    const parsed = SessionSchema.safeParse(args);
    const sesId = parsed.success ? (parsed.data as { sessionId?: string }).sessionId : undefined;
    const sessionId = sesId || getLatestSessionId();

    if (!sessionId) {
      return {
        content: [{ type: "text", text: "No session found. Run ctx_execute or another tool first to create a session." }],
        isError: true,
      };
    }

    const meta = getSessionMeta(sessionId);
    if (!meta) {
      return { content: [{ type: "text", text: `Session ${sessionId} not found` }], isError: true };
    }

    const events = getSessionEvents(sessionId, { limit: 1000 });
    const toolStats = getToolCallStats(sessionId);
    const totalEvents = getEventCount(sessionId);

    // Category breakdown
    const catMap = new Map<string, { count: number; previews: Set<string> }>();
    for (const ev of events) {
      const cat = ev.category || "other";
      let entry = catMap.get(cat);
      if (!entry) { entry = { count: 0, previews: new Set() }; catMap.set(cat, entry); }
      entry.count++;
      if (entry.previews.size < 5) {
        let display = ev.data;
        if (cat === "file") display = display.split("/").pop() ?? display;
        if (display.length > 40) display = display.slice(0, 37) + "...";
        entry.previews.add(display);
      }
    }

    const categoryLabels: Record<string, string> = {
      file: "Files tracked", git: "Git operations", task: "Tasks in progress",
      error: "Errors caught", decision: "Key decisions", rule: "Project rules",
      env: "Environment setup", cwd: "Working directory", mcp: "MCP tools used",
      skill: "Skills used", subagent: "Delegated work",
    };

    const byCategory = Array.from(catMap.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([cat, { count, previews }]) => ({
        category: cat,
        count,
        label: categoryLabels[cat] ?? cat,
        preview: Array.from(previews).join(", "),
      }));

    // Byte savings
    let bytesReturned = 0;
    for (const ev of events) {
      bytesReturned += (ev as unknown as { bytes_returned?: number }).bytes_returned ?? 0;
    }

    const now = Date.now();
    const startMs = new Date(meta.started_at).getTime();
    const uptimeMin = ((now - startMs) / 60_000).toFixed(1);

    const analytics = {
      sessionId: meta.session_id,
      projectDir: meta.project_dir,
      startedAt: meta.started_at,
      uptimeMin,
      totalEvents,
      compactCount: meta.compact_count,
      byCategory,
      toolStats,
      bytesReturned,
    };

    // Build resume snapshot
    incrementCompactCount(sessionId);
    const snapshot = buildResumeSnapshotFromEvents(events, analytics.compactCount + 1);
    if (snapshot) upsertResume(sessionId, snapshot, events.length);

    // Format report
    const lines: string[] = [];
    lines.push("=== Session Statistics ===");
    lines.push(`Session:  ${analytics.sessionId}`);
    lines.push(`Project:  ${analytics.projectDir}`);
    lines.push(`Uptime:   ${analytics.uptimeMin} min`);
    lines.push(`Events:   ${analytics.totalEvents} tracked`);
    lines.push(`Compacts: ${analytics.compactCount}`);
    lines.push("");

    if (analytics.toolStats.totalCalls > 0) {
      lines.push("--- Tool Calls ---");
      lines.push(`Total: ${analytics.toolStats.totalCalls} calls`);
      const topTools = Object.entries(analytics.toolStats.byTool)
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 8);
      for (const [tool, stats] of topTools) {
        lines.push(`  ${tool}: ${stats.calls} calls`);
      }
      lines.push("");
    }

    if (byCategory.length > 0) {
      lines.push("--- Event Categories ---");
      const maxCount = byCategory[0].count;
      for (const cat of byCategory) {
        const bar = maxCount > 0 ? "█".repeat(Math.max(1, Math.round((cat.count / maxCount) * 20))) : "";
        lines.push(`  ${cat.label.padEnd(20)} ${String(cat.count).padStart(4)} ${bar}`);
      }
    }

    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "text", text: JSON.stringify(analytics, null, 2) },
      ],
    };
  },
};
