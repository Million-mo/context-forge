/**
 * Memory tools barrel export
 */

import type { ToolDefinition } from "../../plugin-registry.js";
import { recallTool } from "./recall.js";
import { summarySearchTool } from "./summary-search.js";
import { summaryListTool } from "./summary-list.js";
import { summaryGetTool } from "./summary-get.js";
import { summaryMessagesTool } from "./summary-messages.js";
import { sessionTool } from "./session-report.js";

export { recallTool, summarySearchTool, summaryListTool, summaryGetTool, summaryMessagesTool, sessionTool };

export const memoryTools: ToolDefinition[] = [
  recallTool,
  summarySearchTool,
  summaryListTool,
  summaryGetTool,
  summaryMessagesTool,
  sessionTool,
];
