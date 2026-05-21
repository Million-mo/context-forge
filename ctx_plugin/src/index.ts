/**
 * Barrel export — OpenCode loads local plugins from auto-scanned dirs:
 *
 *   .opencode/plugins/caveman.mjs  ← unified RTK + Caveman plugin
 *   .opencode/tools/fibonacci.ts   ← custom Fibonacci tool
 *
 * opencode.json "plugin" array is for npm packages only, not local .ts paths.
 */

export { CtxPlugin, default as ctxPlugin } from "./plugin.js"
