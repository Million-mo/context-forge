/**
 * Analytics — session statistics and context-saving reports.
 *
 * Pure functions that read from the SessionDB and produce structured
 * reports. Adapted from context-mode's analytics.ts.
 */

import {
  getEvents,
  getSessionStats,
  getToolCallStats,
  getEventCount,
  type StoredEvent,
  type SessionMeta,
  type ToolCallStats,
} from "../session-db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CategoryBreakdown {
  category: string;
  count: number;
  label: string;
  preview: string;
}

export interface SessionAnalytics {
  sessionId: string;
  projectDir: string;
  startedAt: string;
  uptimeMin: string;
  totalEvents: number;
  compactCount: number;
  byCategory: CategoryBreakdown[];
  toolStats: ToolCallStats;
  bytesSaved: number;
  bytesReturned: number;
}

export interface FullReport {
  session: SessionAnalytics;
  resumeReady: boolean;
}

// ── Category labels ──────────────────────────────────────────────────────────

const categoryLabels: Record<string, string> = {
  file: "Files tracked",
  git: "Git operations",
  task: "Tasks in progress",
  error: "Errors caught",
  decision: "Key decisions",
  rule: "Project rules",
  env: "Environment setup",
  cwd: "Working directory",
  mcp: "MCP tools used",
  skill: "Skills used",
  subagent: "Delegated work",
  role: "Behavioral directives",
  intent: "Session mode",
  data: "Data references",
};

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a full analytics report for a session.
 */
export function querySessionAnalytics(sessionId: string): SessionAnalytics | null {
  const meta = getSessionStats(sessionId);
  if (!meta) return null;

  const events = getEvents(sessionId, { limit: 1000 });
  const toolStats = getToolCallStats(sessionId);
  const totalEvents = getEventCount(sessionId);

  // Category breakdown
  const catMap = new Map<string, { count: number; previews: Set<string> }>();
  for (const ev of events) {
    const cat = ev.category || "other";
    let entry = catMap.get(cat);
    if (!entry) {
      entry = { count: 0, previews: new Set() };
      catMap.set(cat, entry);
    }
    entry.count++;
    if (entry.previews.size < 5) {
      let display = ev.data;
      if (cat === "file") {
        display = display.split("/").pop() ?? display;
      }
      if (display.length > 40) display = display.slice(0, 37) + "...";
      entry.previews.add(display);
    }
  }

  const byCategory: CategoryBreakdown[] = Array.from(catMap.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([cat, { count, previews }]) => ({
      category: cat,
      count,
      label: categoryLabels[cat] ?? cat,
      preview: Array.from(previews).join(", "),
    }));

  // Byte savings
  let bytesReturned = 0;
  let bytesSaved = 0;
  for (const ev of events) {
    bytesReturned += (ev as unknown as { bytes_returned?: number }).bytes_returned ?? 0;
    bytesSaved += (ev as unknown as { bytes_avoided?: number }).bytes_avoided ?? 0;
  }

  // Uptime
  const now = Date.now();
  const startMs = new Date(meta.started_at).getTime();
  const uptimeMin = ((now - startMs) / 60_000).toFixed(1);

  return {
    sessionId: meta.session_id,
    projectDir: meta.project_dir,
    startedAt: meta.started_at,
    uptimeMin,
    totalEvents,
    compactCount: meta.compact_count,
    byCategory,
    toolStats,
    bytesSaved,
    bytesReturned,
  };
}

/**
 * Format analytics as a human-readable text report.
 */
export function formatReport(analytics: SessionAnalytics): string {
  const lines: string[] = [];

  lines.push("=== Session Statistics ===");
  lines.push(`Session:  ${analytics.sessionId}`);
  lines.push(`Project:  ${analytics.projectDir}`);
  lines.push(`Uptime:   ${analytics.uptimeMin} min`);
  lines.push(`Events:   ${analytics.totalEvents} tracked`);
  lines.push(`Compacts: ${analytics.compactCount}`);
  lines.push("");

  // Tool stats
  if (analytics.toolStats.totalCalls > 0) {
    lines.push("--- Tool Calls ---");
    lines.push(`Total: ${analytics.toolStats.totalCalls} calls, ${formatBytes(analytics.toolStats.totalBytesReturned)} returned`);
    const topTools = Object.entries(analytics.toolStats.byTool)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 8);
    for (const [tool, stats] of topTools) {
      lines.push(`  ${tool}: ${stats.calls} calls, ${formatBytes(stats.bytesReturned)}`);
    }
    lines.push("");
  }

  // Category breakdown
  if (analytics.byCategory.length > 0) {
    lines.push("--- Event Categories ---");
    const maxCount = analytics.byCategory[0].count;
    for (const cat of analytics.byCategory.slice(0, 10)) {
      const bar = dataBar(cat.count, maxCount, 25);
      lines.push(`  ${cat.label.padEnd(20)} ${String(cat.count).padStart(4)} ${bar}`);
    }
    lines.push("");
  }

  // Savings
  if (analytics.bytesSaved > 0 || analytics.bytesReturned > 0) {
    const total = analytics.bytesSaved + analytics.bytesReturned;
    const pct = total > 0 ? Math.round((analytics.bytesSaved / total) * 100) : 0;
    lines.push("--- Context Savings ---");
    lines.push(`  Kept out of context: ${formatBytes(analytics.bytesSaved)} (${pct}%)`);
    lines.push(`  Returned to context: ${formatBytes(analytics.bytesReturned)}`);
  }

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${Math.round(b)} B`;
}

function dataBar(value: number, max: number, width: number = 30): string {
  if (max <= 0) return "";
  const filled = Math.max(1, Math.round((value / max) * width));
  return "█".repeat(Math.min(filled, width));
}
