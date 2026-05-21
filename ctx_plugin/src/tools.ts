import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// Plugin-style custom tools (requires `bun install` in ctx_plugin/).
// Runtime entry: .opencode/tools/<name>.ts (auto-scanned; filename = tool name)

export const CtxToolsPlugin: Plugin = async () => {
  return {
    tool: {
      fibonacci: tool({
        description:
          "Compute Fibonacci numbers. Returns F(0)..F(n) for n ≤ 50, or a single F(n) when only one value is needed.",
        args: {
          n: tool.schema
            .number()
            .int()
            .min(0)
            .max(50)
            .describe("Index n (0–50). F(0)=0, F(1)=1, F(n)=F(n-1)+F(n-2)."),
          single: tool.schema
            .boolean()
            .optional()
            .describe("If true, return only F(n) instead of the full sequence up to n."),
        },
        async execute(args) {
          const n = args.n
          const seq: number[] = []
          for (let i = 0; i <= n; i++) {
            if (i === 0) seq.push(0)
            else if (i === 1) seq.push(1)
            else seq.push(seq[i - 1]! + seq[i - 2]!)
          }

          if (args.single) {
            return {
              output: `F(${n}) = ${seq[n]}`,
              metadata: { n, value: seq[n] },
            }
          }

          return {
            output: `F(0)..F(${n}): ${seq.join(", ")}`,
            metadata: { n, sequence: seq },
          }
        },
      }),
    },
  }
}

export default CtxToolsPlugin
