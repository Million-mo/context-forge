/**
 * Barrel export — OpenCode loads local plugins from auto-scanned dirs:
 *
 *   .opencode/plugins/rtk.ts  ← RTK command rewrite plugin
 *
 * opencode.json "plugin" array is for npm packages only, not local .ts paths.
 */

export { RtkOpenCodePlugin, default as ctxPlugin } from "./rtk.js"
