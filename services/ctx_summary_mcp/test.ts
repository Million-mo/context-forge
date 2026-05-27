/**
 * Test script for summary-mcp server
 * Sends JSON-RPC messages via stdin/stdout
 */
import { spawn } from "child_process"
import { resolve } from "path"

const TSX = "/Volumes/MOVESPEED/projects/BitFun/Million-mo/context_forge/services/transform-server/node_modules/.bin/tsx"
const dataDir = resolve(process.cwd(), "../transform-server/data")

const server = spawn(TSX, ["src/server.ts"], {
  cwd: resolve(process.cwd()),
  env: { ...process.env, DATA_DIR: dataDir },
  stdio: ["pipe", "pipe", "pipe"],
})

let id = 1
const pending = new Map()

server.stdout.on("data", (data) => {
  const lines = data.toString().trim().split("\n")
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      console.log("←", JSON.stringify(msg, null, 2))
      if (msg.id !== undefined) {
        const resolve = pending.get(msg.id)
        if (resolve) {
          resolve(msg)
          pending.delete(msg.id)
        }
      }
    } catch {
      console.log("← raw:", line)
    }
  }
})

server.stderr.on("data", (data) => {
  console.log("[server]", data.toString().trim())
})

function send(method, params = {}) {
  return new Promise((resolve) => {
    const rid = id++
    pending.set(rid, resolve)
    const msg = { jsonrpc: "2.0", id: rid, method, params }
    server.stdin.write(JSON.stringify(msg) + "\n")
  })
}

async function main() {
  // Initialize
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  })
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")

  await new Promise((r) => setTimeout(r, 200))

  // List tools
  const tools = await send("tools/list")
  console.log("\n=== Available tools ===")
  for (const t of tools.result?.tools || []) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 80)}...`)
  }

  // Health check
  console.log("\n=== summary_health ===")
  const health = await send("tools/call", { name: "summary_health", arguments: {} })
  console.log(JSON.stringify(health.result, null, 2))

  // Search
  console.log("\n=== summary_search (hello) ===")
  const search = await send("tools/call", { name: "summary_search", arguments: { query: "hello", limit: 3 } })
  console.log(JSON.stringify(search.result, null, 2))

  server.kill()
}

main().catch(console.error)
