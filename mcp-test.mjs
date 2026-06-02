/**
 * mcp-test.mjs — Test MCP tools via raw stdio JSON-RPC
 *
 * Usage:
 *   node mcp-test.mjs <toolName> [argsJson]
 *
 * Examples:
 *   node mcp-test.mjs ctx_ping
 *   node mcp-test.mjs ctx_summary_list '{"sessionId":"test-session"}'
 *   node mcp-test.mjs ctx_summary_get '{"sessionId":"test-session","turnIndex":0}'
 *   node mcp-test.mjs ctx_health
 *   node mcp-test.mjs ctx_session
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const SERVER = resolve(process.env.PROJECT_ROOT ?? ".", "mcps/mcp_context_forge/dist/server.js");

function send(stdin, msg) {
  const line = JSON.stringify(msg);
  stdin.write(line + "\n");
}

async function callTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CTX_DISABLE_EXECUTION: "1" },
    });

    let resolved = false;
    let initialized = false;
    let msgId = 1;

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (raw) => {
      if (!raw.trim() || resolved) return;
      let msg;
      try { msg = JSON.parse(raw); }
      catch { return; }

      // initialize response
      if (!initialized && msg.id === 1) {
        initialized = true;
        // send initialized notification
        send(proc.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
        // send tool call
        send(proc.stdin, {
          jsonrpc: "2.0",
          id: msgId++,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        });
      }
      // tool call response
      else if (initialized && msg.id !== 1 && msg.id !== undefined && msg.result !== undefined) {
        resolved = true;
        proc.kill();
        resolve(msg);
      }
      // error
      else if (msg.error) {
        resolved = true;
        proc.kill();
        resolve(msg);
      }
    });

    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.on("error", reject);

    // send initialize
    send(proc.stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-test", version: "1.0.0" },
      },
    });

    setTimeout(() => {
      if (!resolved) { proc.kill(); reject(new Error("Timeout after 15s")); }
    }, 15000);
  });
}

async function main() {
  const toolName = process.argv[2];
  const argsRaw = process.argv[3];
  let args = {};
  if (argsRaw) {
    try { args = JSON.parse(argsRaw); }
    catch { console.error("Invalid JSON args"); process.exit(1); }
  }

  if (!toolName) {
    console.log("Usage: node mcp-test.mjs <toolName> [argsJson]");
    console.log("Tools: ctx_ping, ctx_health, ctx_summary_list, ctx_summary_get, ctx_summary_messages, ctx_session, ctx_content_stats, ctx_content_search, ctx_recall");
    return;
  }

  try {
    const result = await callTool(toolName, args);
    if (result.error) {
      console.error("ERROR:", JSON.stringify(result.error, null, 2));
      process.exit(1);
    }
    const text = result.result?.content?.[0]?.text;
    if (text) {
      try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
      } catch {
        console.log(text);
      }
    } else {
      console.log(JSON.stringify(result.result, null, 2));
    }
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exit(1);
  }
}

main();
