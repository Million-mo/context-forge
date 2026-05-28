/**
 * Barrel export — ctx_plugin provides three opencode plugins:
 *
 *   - CavemanPlugin:  ultra-compressed communication mode
 *   - RoutingPlugin:  tool routing, security policy, shell env
 *   - RtkPlugin:      standalone RTK bash rewrite (rtk.ts)
 *
 * opencode auto-scans .opencode/plugins/ directory.
 * The runtime plugins in .opencode/plugins/ are the active ones.
 *
 * These exports are for programmatic consumption (tests, embedders).
 */

export { CavemanPlugin, default as cavemanPlugin } from "./caveman.js"
export { RoutingPlugin, default as routingPlugin } from "./routing-plugin.js"
export { RtkOpenCodePlugin, default as rtkPlugin } from "./rtk.js"
