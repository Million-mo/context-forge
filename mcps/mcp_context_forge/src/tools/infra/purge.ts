/**
 * ctx_purge — clear session data tool
 */

import { z } from "zod";
import type { ToolDefinition } from "../../plugin-registry.js";

export const PurgeSchema = z.object({
  sessionId: z.string().optional().describe("Specific session to delete"),
  daysOld: z.number().optional().describe("Delete sessions older than N days"),
});

export const purgeTool: ToolDefinition = {
  group: "infra",
  name: "ctx_purge",
  description: "Clear session data from the SQLite event store",
  inputSchema: PurgeSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  handler: async (args: unknown) => {
    const { initSessionDb, deleteSessionById, cleanupOldSessions, getSessionDbPath } = await import("../../services.js");

    initSessionDb();

    if ((args as { sessionId?: string }).sessionId) {
      deleteSessionById((args as { sessionId: string }).sessionId);
      return { content: [{ type: "text", text: `Deleted session: ${(args as { sessionId: string }).sessionId}` }] };
    }

    const purged = cleanupOldSessions((args as { daysOld?: number }).daysOld ?? 7);
    return { content: [{ type: "text", text: `Purged ${purged} old sessions from ${getSessionDbPath()}` }] };
  },
};
