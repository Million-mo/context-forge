/**
 * Tool registry index — re-exports all tools by group.
 */

import type { ToolDefinition } from "../plugin-registry.js";

import { infraTools } from "./infra/index.js";
import { execTools } from "./exec/index.js";
import { indexTools } from "./index/index.js";
// Memory tools (summary/recall/session) migrated to ctx_plugin plugin.
// The MCP keeps only tools that don't depend on OpenCode session context:
// infra (health/ping/purge), exec (execute/batch/runtimes), and index (search/content/stats).

export { infraTools, execTools, indexTools };
