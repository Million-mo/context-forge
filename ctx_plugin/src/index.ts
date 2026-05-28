/**
 * Barrel export — ctx_plugin provides three opencode plugins:
 *
 *   - CavemanPlugin:  ultra-compressed communication mode
 *   - RoutingPlugin:   tool routing, security policy, shell env
 *   - RtkPlugin:      standalone RTK bash rewrite (rtk.ts)
 *
 * opencode auto-scans .opencode/plugins/ directory.
 * The runtime plugins in .opencode/plugins/ are the active ones.
 */

export { RtkOpenCodePlugin } from "./rtk.js"
