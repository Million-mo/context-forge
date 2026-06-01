/**
 * Infra tools barrel export
 */

import type { ToolDefinition } from "../../plugin-registry.js";
import { pingTool } from "./ping.js";
import { doctorTool } from "./doctor.js";
import { purgeTool } from "./purge.js";
import { healthTool } from "./health.js";

export { pingTool, doctorTool, purgeTool, healthTool };

export const infraTools: ToolDefinition[] = [
  pingTool,
  doctorTool,
  purgeTool,
  healthTool,
];
