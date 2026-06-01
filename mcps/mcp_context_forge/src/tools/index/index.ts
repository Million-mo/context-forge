/**
 * Index tools barrel export
 */

import type { ToolDefinition } from "../../plugin-registry.js";
import { indexTool } from "./index-content.js";
import { searchTool } from "./search.js";
import { fetchTool } from "./fetch.js";
import { statsTool } from "./stats.js";

export { indexTool, searchTool, fetchTool, statsTool };

export const indexTools: ToolDefinition[] = [
  indexTool,
  searchTool,
  fetchTool,
  statsTool,
];
