/**
 * Unit tests for transform.ts pure functions.
 * Run with: node --test .opencode/plugins/transform.test.js
 */

import { test, describe } from "node:test"
import assert from "node:assert"
import { createHash } from "node:crypto"

// ─── Pure function re-implementations (mirrors transform.ts) ──────────────────

function deepClone(obj) {
  if (typeof structuredClone === "function") return structuredClone(obj)
  return JSON.parse(JSON.stringify(obj))
}

function safeJsonParse(json, fallback) {
  try { return JSON.parse(json) } catch { return fallback }
}

function estimateTokens(messages) {
  return Math.ceil(messages.reduce((sum, m) => sum + (JSON.stringify(m).length / 4), 0))
}

function getRole(msg) {
  return msg?.info?.role || msg?.role || ""
}

function hashMessages(messages) {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex")
}

const CACHEABLE_TOOLS = new Set(["read", "glob", "grep", "webfetch"])
const DECAY_WEIGHTS = { distance: 1.0, time: 0.3, frequency: 0.5 }
const TOOL_DECAY_MODIFIERS = { read: 0.8, glob: 0.6, grep: 0.7, webfetch: 1.5 }

function buildToolKey(prefix, primaryKey, primaryValue, input) {
  const params = Object.entries(input)
    .filter(([k, v]) => k !== primaryKey && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`).sort().join(";")
  return params ? `${prefix}:${primaryValue};${params}` : `${prefix}:${primaryValue}`
}

function getToolOutputKey(toolName, state) {
  const input = state?.input || {}
  const tool = toolName.toLowerCase()
  switch (tool) {
    case "read": {
      const filePath = input.filePath || input.file || input.path || ""
      const cleanInput = { ...input, filePath }
      delete cleanInput.file
      delete cleanInput.path
      return buildToolKey("file", "filePath", filePath, cleanInput)
    }
    case "grep": return buildToolKey("grep", "pattern", input.pattern || "", input)
    case "glob": return buildToolKey("glob", "pattern", input.pattern || "", input)
    case "webfetch": return buildToolKey("url", "url", input.url || "", input)
    default: return null
  }
}

function splitIntoTurns(messages) {
  if (messages.length === 0) return []
  const turns = []
  let currentTurnStart = 0
  for (let i = 1; i < messages.length; i++) {
    const prevRole = getRole(messages[i - 1])
    const currRole = getRole(messages[i])
    if (prevRole !== "user" && currRole === "user") {
      const turnMessages = messages.slice(currentTurnStart, i)
      turns.push({ index: turns.length, startIdx: currentTurnStart, endIdx: i, messages: turnMessages, isCurrent: false, messageCount: turnMessages.length, tokenEstimate: estimateTokens(turnMessages), contentHash: hashMessages(turnMessages), summaryStatus: "pending" })
      currentTurnStart = i
    }
  }
  const finalMessages = messages.slice(currentTurnStart)
  turns.push({ index: turns.length, startIdx: currentTurnStart, endIdx: messages.length, messages: finalMessages, isCurrent: true, messageCount: finalMessages.length, tokenEstimate: estimateTokens(finalMessages), contentHash: hashMessages(finalMessages), summaryStatus: "pending" })
  return turns
}

function calculateDecayScore(entry, currentTurnIdx, now) {
  const { distance: wDist, time: wTime, frequency: wFreq } = DECAY_WEIGHTS
  const turnDistance = currentTurnIdx - Math.floor(entry.lastSeenTurnIdx / 10)
  const distanceScore = Math.min(turnDistance / 3, 5)
  const timeAgeMinutes = (now - entry.timestamp) / 60000
  const timeScore = Math.log2(timeAgeMinutes + 1) * wTime
  const frequencyScore = Math.log2(entry.callCount + 1) * wFreq
  const toolModifier = TOOL_DECAY_MODIFIERS[entry.toolType] || 1.0
  const baseScore = distanceScore * wDist + timeScore - frequencyScore
  return Math.max(0, Math.min(baseScore * toolModifier, 10))
}

function getCompressionLevel(score) {
  if (score < 2) return "full"
  if (score < 5) return "summary"
  if (score < 8) return "placeholder"
  return "minimal"
}

function compressToolOutput(toolName, state, level) {
  const input = state?.input || {}
  const output = state?.output || ""
  const tool = toolName.toLowerCase()
  switch (tool) {
    case "read": {
      const filePath = input.filePath || input.file || input.path || "?"
      const lines = output.split("\n")
      const lineCount = lines.length
      switch (level) {
        case "placeholder": return `[COMPRESSED: read "${filePath}" — ${lineCount} lines]`
        case "minimal": return `[COMPRESSED: read "${filePath}"]`
        case "summary": return `[COMPRESSED: read "${filePath}"]\n${[...lines.slice(0, 3), `  ... ${Math.max(0, lineCount - 6)} more lines ...`, ...lines.slice(-3)].join("\n")}`
        case "full": return output
      }
    }
    case "glob": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "placeholder": return `[COMPRESSED: glob "${pattern}" — ${count} matches]`
        case "minimal": return `[COMPRESSED: glob "${pattern}"]`
        case "summary": return `[COMPRESSED: glob "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(", ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "full": return output
      }
    }
    case "grep": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "placeholder": return `[COMPRESSED: grep "${pattern}" — ${count} matches]`
        case "minimal": return `[COMPRESSED: grep "${pattern}"]`
        case "summary": return `[COMPRESSED: grep "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(" | ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "full": return output
      }
    }
    case "webfetch": {
      const url = input.url || "?"
      const size = new TextEncoder().encode(output).length
      switch (level) {
        case "placeholder": return `[COMPRESSED: webfetch "${url}" — ${size} bytes]`
        case "minimal": return `[COMPRESSED: webfetch "${url}"]`
        case "summary": return `[COMPRESSED: webfetch "${url}"]\n${output.slice(0, 200)}...`
        case "full": return output
      }
    }
    default: return `[COMPRESSED: ${toolName} — output truncated]`
  }
}

function buildCompressedMessagesForHotTurn(turn, toolOutputs, currentTurnIdx) {
  const now = Date.now()
  const result = []
  for (const msg of turn.messages) {
    const role = getRole(msg)
    if (role !== "assistant") { result.push(deepClone(msg)); continue }
    const cloned = deepClone(msg)
    for (const part of cloned.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue
      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue
      const entry = toolOutputs.get(key)
      if (!entry) continue
      const score = calculateDecayScore(entry, currentTurnIdx, now)
      const level = getCompressionLevel(score)
      if (level !== "full") part.state.output = compressToolOutput(toolName, part.state, level)
    }
    result.push(cloned)
  }
  return result
}

function buildSummaryReplacement(turn) {
  const s = turn.summary
  const timestamp = new Date(turn.messages[0]?.timestamp ?? Date.now()).toLocaleString()
  return [
    { role: "user", info: { role: "user", __compressed: "summary", turnIndex: turn.index }, parts: [{ type: "text", text: `=== Turn ${turn.index} Summary (${timestamp}) ===\nCompressed: ${turn.messageCount} msgs, ~${turn.tokenEstimate} tokens.` }] },
    { role: "assistant", info: { role: "assistant", __compressed: "summary", turnIndex: turn.index }, parts: [{ type: "text", text: s ? ["Turn " + turn.index + " Summary:", "Overview: " + s.overview, s.intent ? "Intent: " + s.intent : null, s.actions.length > 0 ? "Actions: " + s.actions.map((a) => a.tool + "(" + a.target + ")").join(", ") : null, s.artifacts.length > 0 ? "Artifacts: " + s.artifacts.map((a) => a.action + " " + a.path).join(", ") : null, "Outcome: " + s.outcome].filter(Boolean).join("\n") : "(Summary not yet generated)" }] },
  ]
}

function buildPlaceholderReplacement(turn) {
  return [{ role: "user", info: { role: "user", __compressed: "placeholder", turnIndex: turn.index }, parts: [{ type: "text", text: "=== Turn " + turn.index + " (" + turn.messageCount + " msgs, ~" + turn.tokenEstimate + " tokens) ===\n[Compressed]" }] }]
}

function buildCompressedMessages(turns, toolOutputs) {
  const TOKEN_BUDGET = 8000
  const completedTurns = turns.filter((t) => !t.isCurrent)
  const currentTurn = turns.find((t) => t.isCurrent)
  const reservedForCurrent = currentTurn ? estimateTokens(currentTurn.messages) : 0
  const availableBudget = TOKEN_BUDGET - reservedForCurrent
  if (availableBudget <= 0) return currentTurn ? [...currentTurn.messages] : []
  const keptMessages = []
  const replacedTurns = []
  let usedTokens = 0
  for (const turn of [...completedTurns].reverse()) {
    const compressed = buildCompressedMessagesForHotTurn(turn, toolOutputs, turns.length)
    const tokens = estimateTokens(compressed)
    if (usedTokens + tokens <= availableBudget) { keptMessages.unshift(...compressed); usedTokens += tokens }
    else replacedTurns.unshift(turn)
  }
  const result = []
  for (const turn of replacedTurns) {
    if (turn.summaryStatus === "done" && turn.summary) result.push(...buildSummaryReplacement(turn))
    else result.push(...buildPlaceholderReplacement(turn))
  }
  result.push(...keptMessages)
  if (currentTurn) result.push(...currentTurn.messages)
  return result
}

function detectHistoryQuery(parts) {
  let text = ""
  for (const p of parts) { if (p?.type === "text") text += p.text ?? "" }
  text = text.toLowerCase().trim()
  if (!text) return null
  const patterns = [
    /\b(earlier|before|previously|last time|last session|last I|revisit|follow up)\b/,
    /\b(what did I do|what was I working on|show me my|continue that|repeat)\b/,
    /\b(that|this|it).{0,30}(we|I|you).{0,30}(did|made|created|changed|working)\b/i,
    /(?:^|[^a-zA-Z0-9])(之前|上次|之前的|之前做的|那个项目|继续之前|回顾)(?:$|[^a-zA-Z0-9])/,
    /(?:^|[^a-zA-Z0-9])(我之前|我上次|我们之前|它之前|那个文件|那行代码|继续做)(?:$|[^a-zA-Z0-9])/,
    /(?:^|[^a-zA-Z0-9])(我做了什么|我在做什么|做了什么东西|接着之前)(?:$|[^a-zA-Z0-9])/,
  ]
  for (const p of patterns) { if (p.test(text)) return text }
  if (text.length < 50 && /(?:^|[^a-zA-Z0-9])(this|that|it|这里|那里|这个|那个|它|那)(?:$|[^a-zA-Z0-9])/.test(text) && !/(?:^|[^a-zA-Z0-9])(是什么|怎么|help me|what is)(?:$|[^a-zA-Z0-9])/.test(text)) return text
  return null
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

function textMsg(role, text) {
  return { role, info: { role }, parts: [{ type: "text", text }] }
}
function toolMsg(toolName, input, output, status = "completed") {
  return { role: "assistant", info: { role: "assistant" }, parts: [{ type: "text", text: "" }, { type: "tool", tool: toolName, state: { status, input, output } }] }
}
function makeTurn(index, messages, isCurrent, summaryStatus = "pending", summary = undefined) {
  return { index, startIdx: 0, endIdx: messages.length, messages, isCurrent, messageCount: messages.length, tokenEstimate: estimateTokens(messages), contentHash: hashMessages(messages), summaryStatus, summary }
}

// ─── Tests: Helpers ──────────────────────────────────────────────────────────

describe("deepClone", () => {
  test("deep clones primitives", () => { assert.strictEqual(deepClone(42), 42) })
  test("deep clones arrays", () => { const orig = [1, 2, 3]; const cloned = deepClone(orig); orig.push(4); assert.deepStrictEqual(cloned, [1, 2, 3]) })
  test("deep clones objects", () => { const orig = { a: { b: 1 } }; const cloned = deepClone(orig); orig.a.b = 999; assert.strictEqual(cloned.a.b, 1) })
})

describe("safeJsonParse", () => {
  test("parses valid JSON", () => { assert.deepStrictEqual(safeJsonParse('{"x":1}', {}), { x: 1 }) })
  test("returns fallback on invalid JSON", () => { assert.deepStrictEqual(safeJsonParse("not json", { fallback: true }), { fallback: true }) })
  test("returns fallback on empty string", () => { assert.deepStrictEqual(safeJsonParse("", []), []) })
})

// ─── Tests: splitIntoTurns ───────────────────────────────────────────────────

describe("splitIntoTurns", () => {
  test("empty array returns empty", () => { assert.deepStrictEqual(splitIntoTurns([]), []) })
  test("single user message is current turn", () => {
    const turns = splitIntoTurns([textMsg("user", "hello")])
    assert.strictEqual(turns.length, 1)
    assert.strictEqual(turns[0].isCurrent, true)
    assert.strictEqual(turns[0].messageCount, 1)
  })
  test("system message alone is current turn", () => {
    const turns = splitIntoTurns([textMsg("system", "sys prompt")])
    assert.strictEqual(turns.length, 1)
    assert.strictEqual(turns[0].isCurrent, true)
  })
  test("splits on user message boundaries", () => {
    const msgs = [textMsg("system", "sys"), textMsg("user", "t1"), textMsg("assistant", "r1"), textMsg("user", "t2"), textMsg("assistant", "r2")]
    const turns = splitIntoTurns(msgs)
    assert.strictEqual(turns.length, 3)
    assert.strictEqual(turns[0].isCurrent, false)
    assert.strictEqual(turns[0].messages.length, 1)
    assert.strictEqual(turns[1].isCurrent, false)
    assert.strictEqual(turns[1].messages.length, 2)
    assert.strictEqual(turns[2].isCurrent, true)
    assert.strictEqual(turns[2].messages.length, 2)
  })
  test("consecutive assistants stay in same turn", () => {
    const msgs = [textMsg("user", "q"), textMsg("assistant", "a"), textMsg("assistant", "a2")]
    const turns = splitIntoTurns(msgs)
    assert.strictEqual(turns.length, 1)
    assert.strictEqual(turns[0].isCurrent, true)
    assert.strictEqual(turns[0].messages.length, 3)
  })
  test("sequential index assignment", () => {
    const msgs = [textMsg("user", "1"), textMsg("assistant", "1"), textMsg("user", "2"), textMsg("assistant", "2"), textMsg("user", "3"), textMsg("assistant", "3")]
    assert.deepStrictEqual(splitIntoTurns(msgs).map((t) => t.index), [0, 1, 2])
  })
  test("contentHash is deterministic", () => {
    const msgs = [textMsg("user", "hello"), textMsg("assistant", "world")]
    const t1 = splitIntoTurns(msgs)
    const t2 = splitIntoTurns(msgs)
    assert.strictEqual(t1[0].contentHash, t2[0].contentHash)
  })
})

// ─── Tests: getToolOutputKey ─────────────────────────────────────────────────

describe("getToolOutputKey", () => {
  test("read with filePath", () => { assert.strictEqual(getToolOutputKey("read", { input: { filePath: "foo.ts" } }), "file:foo.ts") })
  test("read with params", () => { assert.strictEqual(getToolOutputKey("read", { input: { filePath: "foo.ts", offset: 10, limit: 20 } }), "file:foo.ts;limit=20;offset=10") })
  test("read with alternative keys (file/filePath/path)", () => {
    assert.strictEqual(getToolOutputKey("read", { input: { file: "a.ts" } }), "file:a.ts")
    assert.strictEqual(getToolOutputKey("read", { input: { path: "b.ts" } }), "file:b.ts")
  })
  test("grep with pattern", () => { assert.strictEqual(getToolOutputKey("grep", { input: { pattern: "TODO" } }), "grep:TODO") })
  test("grep with context", () => { assert.strictEqual(getToolOutputKey("grep", { input: { pattern: "TODO", caseSensitive: false, path: "src" } }), "grep:TODO;caseSensitive=false;path=src") })
  test("glob with pattern", () => { assert.strictEqual(getToolOutputKey("glob", { input: { pattern: "**/*.ts" } }), "glob:**/*.ts") })
  test("webfetch with url", () => { assert.strictEqual(getToolOutputKey("webfetch", { input: { url: "https://example.com" } }), "url:https://example.com") })
  test("unknown tool returns null", () => { assert.strictEqual(getToolOutputKey("shell", { input: { command: "ls" } }), null) })
  test("case insensitive tool name", () => { assert.strictEqual(getToolOutputKey("READ", { input: { filePath: "x.ts" } }), "file:x.ts") })
  test("key is stable regardless of param order", () => {
    const k1 = getToolOutputKey("read", { input: { filePath: "a.ts", extra: "x" } })
    const k2 = getToolOutputKey("read", { input: { extra: "x", filePath: "a.ts" } })
    assert.strictEqual(k1, k2)
  })
})

// ─── Tests: Decay Scoring ────────────────────────────────────────────────────

describe("calculateDecayScore + getCompressionLevel", () => {
  test("recent call has low score", () => {
    const entry = { toolType: "read", lastSeenTurnIdx: 0, timestamp: Date.now(), callCount: 1 }
    const score = calculateDecayScore(entry, 1, Date.now())
    assert.ok(score < 2, `Expected score < 2, got ${score}`)
  })
  test("old call has higher score", () => {
    const entry = { toolType: "read", lastSeenTurnIdx: 0, timestamp: Date.now() - 7200000, callCount: 1 }
    const score = calculateDecayScore(entry, 5, Date.now())
    assert.ok(score >= 2, `Expected score >= 2, got ${score}`)
  })
  test("webfetch decays faster than read", () => {
    const now = Date.now() - 3600000
    const readEntry = { toolType: "read", lastSeenTurnIdx: 0, timestamp: now, callCount: 1 }
    const wfEntry = { toolType: "webfetch", lastSeenTurnIdx: 0, timestamp: now, callCount: 1 }
    const s1 = calculateDecayScore(readEntry, 5, now + 1000)
    const s2 = calculateDecayScore(wfEntry, 5, now + 1000)
    assert.ok(s2 > s1, `webfetch (${s2.toFixed(2)}) should decay faster than read (${s1.toFixed(2)})`)
  })
  test("frequent calls have lower score", () => {
    const now = Date.now() - 3600000
    const once = { toolType: "read", lastSeenTurnIdx: 0, timestamp: now, callCount: 1 }
    const many = { toolType: "read", lastSeenTurnIdx: 0, timestamp: now, callCount: 10 }
    const s1 = calculateDecayScore(once, 5, now + 1000)
    const s2 = calculateDecayScore(many, 5, now + 1000)
    assert.ok(s2 < s1, `frequent (${s2.toFixed(2)}) should have lower score than once (${s1.toFixed(2)})`)
  })
  test("score is clamped to [0, 10]", () => {
    const entry = { toolType: "read", lastSeenTurnIdx: 0, timestamp: 0, callCount: 1 }
    const score = calculateDecayScore(entry, 1000, Date.now())
    assert.ok(score <= 10 && score >= 0, `Score ${score} should be in [0, 10]`)
  })
  test("score < 2 → full", () => { assert.strictEqual(getCompressionLevel(0), "full") })
  test("score 2-4 → summary", () => { assert.strictEqual(getCompressionLevel(3), "summary") })
  test("score 5-7 → placeholder", () => { assert.strictEqual(getCompressionLevel(6), "placeholder") })
  test("score >= 8 → minimal", () => { assert.strictEqual(getCompressionLevel(9), "minimal") })
})

// ─── Tests: compressToolOutput ───────────────────────────────────────────────

describe("compressToolOutput", () => {
  test("read full returns original", () => {
    assert.strictEqual(compressToolOutput("read", { output: "hello world", input: { filePath: "x.ts" } }, "full"), "hello world")
  })
  test("read minimal", () => {
    assert.strictEqual(compressToolOutput("read", { output: "line1\nline2", input: { filePath: "x.ts" } }, "minimal"), '[COMPRESSED: read "x.ts"]')
  })
  test("read placeholder shows line count", () => {
    const result = compressToolOutput("read", { output: "a\nb\nc\nd\ne", input: { filePath: "x.ts" } }, "placeholder")
    assert.ok(result.includes("5 lines"))
  })
  test("read summary shows first+last lines", () => {
    const result = compressToolOutput("read", { output: "line1\nline2\nline3\nline4\nline5\nline6\nline7", input: { filePath: "x.ts" } }, "summary")
    assert.ok(result.includes("line1"))
    assert.ok(result.includes("line7"))
    assert.ok(result.includes("... 1 more lines ..."))
  })
  test("grep summary", () => {
    const result = compressToolOutput("grep", { output: "a\nb\nc\nd\ne", input: { pattern: "TODO" } }, "summary")
    assert.ok(result.includes('grep "TODO"'))
    assert.ok(result.includes("5 matches"))
  })
  test("grep placeholder", () => {
    assert.ok(compressToolOutput("grep", { output: "a\nb\nc", input: { pattern: "TODO" } }, "placeholder").includes("3 matches"))
  })
  test("grep minimal", () => {
    assert.strictEqual(compressToolOutput("grep", { output: "x", input: { pattern: "TODO" } }, "minimal"), '[COMPRESSED: grep "TODO"]')
  })
  test("glob summary", () => {
    const result = compressToolOutput("glob", { output: "a.ts\nb.ts\nc.ts", input: { pattern: "**/*.ts" } }, "summary")
    assert.ok(result.includes('glob "**/*.ts"'))
    assert.ok(result.includes("3 matches"))
  })
  test("webfetch placeholder shows bytes", () => {
    const result = compressToolOutput("webfetch", { output: "hello world", input: { url: "https://x.com" } }, "placeholder")
    assert.ok(result.includes("bytes"))
  })
  test("webfetch minimal", () => {
    assert.strictEqual(compressToolOutput("webfetch", { output: "x", input: { url: "https://x.com" } }, "minimal"), '[COMPRESSED: webfetch "https://x.com"]')
  })
  test("unknown tool default", () => {
    assert.strictEqual(compressToolOutput("shell", { output: "output", input: {} }, "full"), "[COMPRESSED: shell — output truncated]")
  })
})

// ─── Tests: buildSummaryReplacement + buildPlaceholderReplacement ─────────────

describe("buildSummaryReplacement", () => {
  test("returns 2 messages", () => {
    const turn = makeTurn(1, [textMsg("user", "x")], false, "done", { turnIndex: 1, overview: "Fixed bug", intent: "Fix", actions: [], artifacts: [], outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now() })
    const msgs = buildSummaryReplacement(turn)
    assert.strictEqual(msgs.length, 2)
    assert.strictEqual(msgs[0].role, "user")
    assert.strictEqual(msgs[1].role, "assistant")
  })
  test("marks with __compressed=summary", () => {
    const turn = makeTurn(3, [textMsg("user", "x")], false, "done", { turnIndex: 3, overview: "", intent: "", actions: [], artifacts: [], outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now() })
    const msgs = buildSummaryReplacement(turn)
    assert.strictEqual(msgs[0].info.__compressed, "summary")
    assert.strictEqual(msgs[1].info.__compressed, "summary")
  })
  test("contains all summary fields", () => {
    const turn = makeTurn(1, [textMsg("user", "x")], false, "done", { turnIndex: 1, overview: "Refactored", intent: "Improve", actions: [{ tool: "read", target: "api.ts", description: "read", result: "ok" }], artifacts: [{ path: "api.ts", action: "modified", detail: "" }], outcome: "success", errors: [], todos: [], confidence: 0.95, generatedAt: Date.now() })
    const text = buildSummaryReplacement(turn)[1].parts[0].text
    assert.ok(text.includes("Refactored"))
    assert.ok(text.includes("Intent: Improve"))
    assert.ok(text.includes("read(api.ts)"))
    assert.ok(text.includes("modified api.ts"))
    assert.ok(text.includes("Outcome: success"))
  })
  test("no summary → not yet generated", () => {
    const turn = makeTurn(1, [textMsg("user", "x")], false, "unavailable")
    const text = buildSummaryReplacement(turn)[1].parts[0].text
    assert.ok(text.includes("not yet generated"))
  })
})

describe("buildPlaceholderReplacement", () => {
  test("returns 1 message with __compressed=placeholder", () => {
    const turn = makeTurn(2, [textMsg("user", "x"), textMsg("assistant", "y")], false)
    const msgs = buildPlaceholderReplacement(turn)
    assert.strictEqual(msgs.length, 1)
    assert.strictEqual(msgs[0].info.__compressed, "placeholder")
    assert.strictEqual(msgs[0].info.turnIndex, 2)
    assert.ok(msgs[0].parts[0].text.includes("2 msgs"))
  })
})

// ─── Tests: buildCompressedMessagesForHotTurn ───────────────────────────────

describe("buildCompressedMessagesForHotTurn", () => {
  test("preserves non-assistant messages", () => {
    const turn = makeTurn(0, [textMsg("user", "read foo"), textMsg("assistant", "here")], false)
    const result = buildCompressedMessagesForHotTurn(turn, new Map(), 1)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].role, "user")
  })
  test("no compression if tool not in index", () => {
    const turn = makeTurn(0, [textMsg("user", "read"), toolMsg("read", { filePath: "foo.ts" }, "original content")], false)
    const result = buildCompressedMessagesForHotTurn(turn, new Map(), 1)
    assert.strictEqual(result[1].parts[1].state.output, "original content")
  })
  test("compresses old tool outputs", () => {
    const turn = makeTurn(0, [textMsg("user", "read"), toolMsg("read", { filePath: "foo.ts" }, "line1\nline2\nline3\nline4\nline5")], false)
    const toolOutputs = new Map([["file:foo.ts", { key: "file:foo.ts", toolType: "read", output: "line1\nline2\nline3\nline4\nline5", timestamp: Date.now() - 3600000, lastSeenTurnIdx: 0, callCount: 1 }]])
    const result = buildCompressedMessagesForHotTurn(turn, toolOutputs, 5)
    assert.ok(result[1].parts[1].state.output.includes("[COMPRESSED:"))
  })
  test("does not compress recent outputs (score < 2)", () => {
    const turn = makeTurn(0, [textMsg("user", "read"), toolMsg("read", { filePath: "foo.ts" }, "content")], false)
    const toolOutputs = new Map([["file:foo.ts", { key: "file:foo.ts", toolType: "read", output: "content", timestamp: Date.now(), lastSeenTurnIdx: 0, callCount: 1 }]])
    const result = buildCompressedMessagesForHotTurn(turn, toolOutputs, 1)
    assert.strictEqual(result[1].parts[1].state.output, "content")
  })
  test("does not mutate original messages", () => {
    const turn = makeTurn(0, [textMsg("user", "read"), toolMsg("read", { filePath: "foo.ts" }, "content")], false)
    const toolOutputs = new Map([["file:foo.ts", { key: "file:foo.ts", toolType: "read", output: "content", timestamp: Date.now() - 7200000, lastSeenTurnIdx: 0, callCount: 1 }]])
    buildCompressedMessagesForHotTurn(turn, toolOutputs, 5)
    assert.strictEqual(turn.messages[1].parts[1].state.output, "content")
  })
  test("skips non-cacheable tools", () => {
    const turn = makeTurn(0, [textMsg("user", "run"), toolMsg("shell", { command: "ls" }, "output")], false)
    const result = buildCompressedMessagesForHotTurn(turn, new Map(), 1)
    assert.strictEqual(result[1].parts[1].state.output, "output")
  })
  test("skips failed tool calls", () => {
    const turn = makeTurn(0, [textMsg("user", "read"), toolMsg("read", { filePath: "foo.ts" }, "error", "error")], false)
    const result = buildCompressedMessagesForHotTurn(turn, new Map(), 1)
    assert.strictEqual(result[1].parts[1].state.output, "error")
  })
})

// ─── Tests: buildCompressedMessages (token budget) ───────────────────────────

describe("buildCompressedMessages", () => {
  test("current turn always included", () => {
    const turns = [makeTurn(0, [textMsg("user", "x"), textMsg("assistant", "y")], false), makeTurn(1, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true)]
    const result = buildCompressedMessages(turns, new Map())
    assert.ok(result.some((m) => m.parts?.[0]?.text === "curreply"))
  })
  test("under budget: all completed turns kept", () => {
    const turns = [makeTurn(0, [textMsg("user", "old"), textMsg("assistant", "old reply")], false), makeTurn(1, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true)]
    const result = buildCompressedMessages(turns, new Map())
    assert.ok(result.some((m) => m.parts?.[0]?.text === "old reply"))
    assert.ok(result.some((m) => m.parts?.[0]?.text === "curreply"))
  })
  test("over budget: oldest turns replaced with summaries from front", () => {
    // Each char ~0.25 tokens. Need >8000 tokens across all turns to force compression.
    // 10000-char string ≈ 2500 tokens. With 2 msgs per turn ≈ 5000 tokens per turn.
    // 2 large turns + current turn > 8000 budget.
    const large = "x".repeat(10000)
    const turns = [
      makeTurn(0, [textMsg("user", "old" + large), textMsg("assistant", "r" + large)], false, "done", { turnIndex: 0, overview: "old", intent: "", actions: [], artifacts: [], outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now() }),
      makeTurn(1, [textMsg("user", "t1" + large), textMsg("assistant", "r1" + large)], false, "pending"),
      makeTurn(2, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true),
    ]
    const result = buildCompressedMessages(turns, new Map())
    const t0 = result.find((m) => m.info?.turnIndex === 0 && m.role === "user")
    assert.strictEqual(t0?.info?.__compressed, "summary")
    assert.ok(!result.some((m) => m.parts?.[0]?.text?.includes("old" + large.slice(0, 10))))
    assert.ok(result.some((m) => m.parts?.[0]?.text === "curreply"))
  })
  test("no summary → placeholder", () => {
    // Need enough content to EXCEED available budget (8000 - ~13 for current = 7987).
    // Each large msg ≈ 4000 tokens. 2 large + current > 7987 → compression.
    const large = "x".repeat(16000)
    const turns = [
      makeTurn(0, [textMsg("user", "old" + large), textMsg("assistant", "r" + large)], false, "pending"),
      makeTurn(1, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true),
    ]
    const result = buildCompressedMessages(turns, new Map())
    const t0 = result.find((m) => m.info?.turnIndex === 0 && m.role === "user")
    assert.strictEqual(t0?.info?.__compressed, "placeholder")
  })
  test("current turn always last", () => {
    const turns = [makeTurn(0, [textMsg("user", "old"), textMsg("assistant", "old reply")], false), makeTurn(1, [textMsg("user", "new"), textMsg("assistant", "new reply")], true)]
    const result = buildCompressedMessages(turns, new Map())
    assert.strictEqual(result.findIndex((m) => m.parts?.[0]?.text === "new reply"), result.length - 1)
  })
  test("empty turns returns empty", () => { assert.deepStrictEqual(buildCompressedMessages([], new Map()), []) })
})

// ─── Tests: detectHistoryQuery ───────────────────────────────────────────────

describe("detectHistoryQuery", () => {
  test("detects 'earlier'", () => { assert.ok(detectHistoryQuery([{ type: "text", text: "what did I do earlier" }])) })
  test("detects 'previously'", () => { assert.ok(detectHistoryQuery([{ type: "text", text: "continue from previously" }])) })
  test("detects Chinese '之前'", () => { assert.ok(detectHistoryQuery([{ type: "text", text: "我之前做的那个" }])) })
  test("detects '上次'", () => { assert.ok(detectHistoryQuery([{ type: "text", text: "上次我们聊到哪了" }])) })
  test("detects short deictic 'this'", () => {
    assert.ok(detectHistoryQuery([{ type: "text", text: "this is confusing" }]))
  })
  test("ignores 'what is' questions", () => {
    assert.strictEqual(detectHistoryQuery([{ type: "text", text: "what is this function" }]), null)
  })
  test("ignores long deictic with '是什么'", () => {
    assert.strictEqual(detectHistoryQuery([{ type: "text", text: "这个文件的逻辑是什么" }]), null)
  })
  test("empty parts returns null", () => { assert.strictEqual(detectHistoryQuery([]), null) })
  test("empty text returns null", () => { assert.strictEqual(detectHistoryQuery([{ type: "text", text: "" }]), null) })
  test("null parts handled gracefully", () => { assert.strictEqual(detectHistoryQuery([null]), null) })
})

// ─── Integration ────────────────────────────────────────────────────────────

describe("Integration", () => {
  test("5 turns end-to-end with generous budget", () => {
    const raw = [textMsg("user", "t1"), textMsg("assistant", "r1"), textMsg("user", "t2"), textMsg("assistant", "r2"), textMsg("user", "t3"), textMsg("assistant", "r3"), textMsg("user", "t4"), textMsg("assistant", "r4"), textMsg("user", "t5"), textMsg("assistant", "r5")]
    const turns = splitIntoTurns(raw)
    assert.strictEqual(turns.length, 5)
    const result = buildCompressedMessages(turns, new Map())
    assert.ok(result.some((m) => m.parts?.[0]?.text === "r1"))
    assert.ok(result.some((m) => m.parts?.[0]?.text === "r5"))
  })
  test("tool dedup across turns", () => {
    const turns = [
      makeTurn(0, [textMsg("user", "read foo"), toolMsg("read", { filePath: "foo.ts" }, "v1")], false),
      makeTurn(1, [textMsg("user", "read foo again"), toolMsg("read", { filePath: "foo.ts" }, "v2")], false),
    ]
    const toolOutputs = new Map([["file:foo.ts", { key: "file:foo.ts", toolType: "read", output: "v2", timestamp: Date.now(), lastSeenTurnIdx: 1, callCount: 2 }]])
    const result = buildCompressedMessagesForHotTurn(turns[1], toolOutputs, 2)
    assert.strictEqual(result.length, 2)
  })
})
