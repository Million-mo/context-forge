/**
 * Barrel export — ctx_plugin provides unified RTK + Caveman plugin
 *
 * The main entry point is plugin.ts which combines:
 *   - RTK: bash/shell command rewriting via `rtk rewrite`
 *   - Caveman: ultra-compressed communication mode with session tracking
 *
 * opencode.json "plugin" array is for npm packages only, not local .ts paths.
 * opencode auto-scans .opencode/plugins/ directory.
 */

export { CtxPlugin, default as ctxPlugin } from "./plugin.js"
