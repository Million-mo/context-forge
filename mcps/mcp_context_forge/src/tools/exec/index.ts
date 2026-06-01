/**
 * Exec tools barrel export
 */

import type { ToolDefinition } from "../../plugin-registry.js";
import { executeTool } from "./execute.js";
import { executeFileTool } from "./execute-file.js";
import { batchExecuteTool } from "./batch-execute.js";
import { runtimesTool } from "./runtimes.js";

export { executeTool, executeFileTool, batchExecuteTool, runtimesTool };

export const execTools: ToolDefinition[] = [
  executeTool,
  executeFileTool,
  batchExecuteTool,
  runtimesTool,
];
