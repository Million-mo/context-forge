/**
 * hooks/index.ts — Barrel export for routing hooks
 */
export { normalizeToolName, isCtxPluginTool, isExternalMcpTool, toolDisplayName } from "./tool-naming.js";
export { buildGuidanceContext, showGuidanceOnce, isGuidanceShown, resetGuidanceState } from "./guidance.js";
export { routeTool, ROUTING_BLOCK } from "./routing.js";
export { GUIDANCE_MESSAGES } from "./guidance.js";
