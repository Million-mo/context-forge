import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"

// Plugin-style custom tools (requires `bun install` in ctx_plugin/).
// Runtime entry used by OpenCode: .opencode/tools/dir_size.ts (auto-scanned).
// Add more tools as separate files under .opencode/tools/<name>.ts

export const CtxToolsPlugin: Plugin = async () => {
  return {
    tool: {
      dir_size: tool({
        description:
          "Get total disk usage of the project directory (or a subdirectory). Uses `du -sh`.",
        args: {
          subdir: tool.schema
            .string()
            .optional()
            .describe(
              "Optional subdirectory relative to project root. Defaults to '.' (entire project).",
            ),
        },
        async execute(args, ctx) {
          const target = args.subdir ?? "."
          const fullPath =
            target === "." ? ctx.directory : `${ctx.directory}/${target}`

          await Effect.runPromise(
            ctx.ask({
              permission: "dir_size",
              patterns: [target],
              always: [`du -sh ${target}*`],
              metadata: { tool: "dir_size", path: fullPath },
            }),
          )

          const { execSync } = await import("node:child_process")
          const raw = execSync(`du -sh "${fullPath}" 2>/dev/null || echo "unknown"`, {
            encoding: "utf-8",
            timeout: 15000,
          }).trim()
          const size = raw.split(/\s+/)[0] || "unknown"

          return {
            output: `Directory "${target}" total size: ${size}`,
            metadata: { path: fullPath, size },
          }
        },
      }),
    },
  }
}

export default CtxToolsPlugin
