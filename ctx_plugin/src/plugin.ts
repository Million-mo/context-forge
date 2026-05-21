/**
 * ctx_plugin — unified opencode plugin
 *
 * Merges two capabilities into one:
 *   - RTK: intercepts bash/shell tool calls and rewrites commands via `rtk rewrite`
 *   - (Caveman: deferred — requires further investigation of chat.message lifecycle)
 *
 * Source of truth lives here. Mirror to .opencode/plugins/caveman.mjs for runtime.
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// RTK
// ---------------------------------------------------------------------------

async function checkRtkAvailable($: Awaited<PluginInput["$"]>): Promise<boolean> {
  try {
    await $`which rtk`.quiet()
    return true
  } catch {
    console.warn("[ctx_plugin] rtk binary not found in PATH — RTK hooks disabled")
    return false
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const CtxPlugin: Plugin = async (input) => {
  const $ = input.$
  const rtkAvailable = await checkRtkAvailable($)

  return {
    // RTK: rewrite bash/shell commands before execution
    "tool.execute.before": async (input, output) => {
      const tool = input.tool.toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      const args = output.args as Record<string, unknown> | undefined
      if (!args?.command) return
      const command = String(args.command)
      if (!command) return

      if (rtkAvailable) {
        try {
          const result = await $`rtk rewrite ${command}`.quiet().nothrow()
          const rewritten = String(result.stdout).trim()
          if (rewritten && rewritten !== command) {
            args.command = rewritten
          }
        } catch {}
      }
    },
  }
}

export default CtxPlugin
