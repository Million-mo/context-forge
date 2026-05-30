/**
 * Snapshot builder — converts stored SessionEvents into a compact
 * resume snapshot for injection into the LLM context after compaction.
 *
 * Pure functions only. No database access, no file system, no side effects.
 *
 * The snapshot is a lightweight "table of contents" — it lists what happened
 * without embedding raw data, keeping token cost minimal. For full details
 * the model can use ctx_content_search on the indexed session events.
 */

import type { StoredEvent } from "../session-db.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BuildSnapshotOpts {
  compactCount?: number;
  searchTool?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function dedupe(items: string[], max = 15): string[] {
  return [...new Set(items.filter((s) => s.length > 0))].slice(0, max);
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildFilesSection(fileEvents: StoredEvent[]): string {
  if (fileEvents.length === 0) return "";

  const fileMap = new Map<string, { reads: number; writes: number }>();

  for (const ev of fileEvents) {
    const path = ev.data;
    let entry = fileMap.get(path);
    if (!entry) {
      entry = { reads: 0, writes: 0 };
      fileMap.set(path, entry);
    }
    if (ev.type === "file_write") entry.writes++;
    else entry.reads++;
  }

  const lines: string[] = [];
  const entries = Array.from(fileMap.entries()).slice(-12); // last 12 files

  for (const [path, { reads, writes }] of entries) {
    const name = path.split("/").pop() ?? path;
    const parts: string[] = [];
    if (reads > 0) parts.push(`read×${reads}`);
    if (writes > 0) parts.push(`write×${writes}`);
    lines.push(`  ${name} (${parts.join(", ")})`);
  }

  if (lines.length === 0) return "";
  return `Files (${fileMap.size} tracked):\n${lines.join("\n")}`;
}

function buildGitSection(gitEvents: StoredEvent[]): string {
  if (gitEvents.length === 0) return "";
  const commands = dedupe(gitEvents.map((e) => e.data), 8);
  return `Git operations (${gitEvents.length}):\n${commands.map((c) => `  ${c}`).join("\n")}`;
}

function buildDecisionsSection(decisionEvents: StoredEvent[]): string {
  if (decisionEvents.length === 0) return "";
  const decisions = dedupe(decisionEvents.map((e) => e.data), 6);
  return `Key decisions:\n${decisions.map((d) => `  - ${d}`).join("\n")}`;
}

function buildTasksSection(taskEvents: StoredEvent[]): string {
  if (taskEvents.length === 0) return "";
  const tasks = dedupe(taskEvents.map((e) => e.data), 8);
  return `Tasks in progress:\n${tasks.map((t) => `  - ${t}`).join("\n")}`;
}

function buildErrorsSection(errorEvents: StoredEvent[]): string {
  if (errorEvents.length === 0) return "";
  const errors = dedupe(errorEvents.map((e) => e.data), 5);
  return `Errors encountered:\n${errors.map((e) => `  - ${e}`).join("\n")}`;
}

function buildEnvironmentSection(
  cwdEvents: StoredEvent[],
  envEvents: StoredEvent[],
): string {
  if (cwdEvents.length === 0 && envEvents.length === 0) return "";

  const lines: string[] = [];
  if (cwdEvents.length > 0) {
    const last = cwdEvents[cwdEvents.length - 1];
    lines.push(`  cwd: ${last.data}`);
  }
  for (const ev of envEvents.slice(-5)) {
    lines.push(`  ${ev.data}`);
  }
  return `Environment:\n${lines.join("\n")}`;
}

function buildRulesSection(ruleEvents: StoredEvent[]): string {
  if (ruleEvents.length === 0) return "";
  const rules = dedupe(ruleEvents.map((e) => e.data), 5);
  return `Project rules loaded:\n${rules.map((r) => `  ${r}`).join("\n")}`;
}

function buildSkillsSection(skillEvents: StoredEvent[]): string {
  if (skillEvents.length === 0) return "";

  const counts = new Map<string, number>();
  for (const ev of skillEvents) {
    counts.set(ev.data, (counts.get(ev.data) ?? 0) + 1);
  }

  const lines: string[] = [];
  for (const [name, count] of counts) {
    lines.push(`  ${name} (${count}×)`);
  }
  return `Skills used:\n${lines.join("\n")}`;
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a compact resume snapshot from stored session events.
 *
 * Returns a plain-text summary organised by category. Designed to be
 * injected into the LLM context so it can quickly understand session
 * state without re-reading individual files.
 */
export function buildResumeSnapshot(
  events: StoredEvent[],
  opts?: BuildSnapshotOpts,
): string {
  if (events.length === 0) return "";

  const compactCount = opts?.compactCount ?? 1;
  const searchTool = opts?.searchTool ?? "ctx_content_search";

  // Group by category
  const byCategory: Record<string, StoredEvent[]> = {};
  for (const ev of events) {
    const cat = ev.category || "other";
    (byCategory[cat] ??= []).push(ev);
  }

  const sections: string[] = [];

  // Files
  const files = buildFilesSection(byCategory["file"] ?? []);
  if (files) sections.push(files);

  // Git
  const git = buildGitSection(byCategory["git"] ?? []);
  if (git) sections.push(git);

  // Decisions
  const decisions = buildDecisionsSection(byCategory["decision"] ?? []);
  if (decisions) sections.push(decisions);

  // Tasks
  const tasks = buildTasksSection(byCategory["task"] ?? []);
  if (tasks) sections.push(tasks);

  // Errors
  const errors = buildErrorsSection(byCategory["error"] ?? []);
  if (errors) sections.push(errors);

  // Rules
  const rules = buildRulesSection(byCategory["rule"] ?? []);
  if (rules) sections.push(rules);

  // Environment
  const env = buildEnvironmentSection(byCategory["cwd"] ?? [], byCategory["env"] ?? []);
  if (env) sections.push(env);

  // Skills
  const skills = buildSkillsSection(byCategory["skill"] ?? []);
  if (skills) sections.push(skills);

  if (sections.length === 0) return "";

  const header = [
    `=== Session Resume (compact #${compactCount}, ${events.length} events) ===`,
    `For full details on any item, use: ${searchTool}(query="...", source="session-events")`,
    "",
  ].join("\n");

  return header + sections.join("\n\n");
}
