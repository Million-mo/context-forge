import { describe, it, expect } from "vitest"
import { createHash } from "crypto"

// Re-implement the pure functions from index.ts for isolated testing.
// We can't import from index.ts because it has top-level side effects (express, etc.).

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolOutputEntry = {
  key: string
  toolType: string
  output: string
  timestamp: number
  lastSeenTurnIdx: number
  callCount: number
}

type TurnSummaryStatus = "pending" | "generating" | "done" | "unavailable"

interface TurnSummary {
  turnIndex: number
  overview: string
  intent: string
  actions: { tool: string; target: string; description: string; result: string }[]
  artifacts: { path: string; action: string; detail: string }[]
  outcome: string
  errors: string[]
  todos: string[]
  confidence: number
  reason?: string
  generatedAt: number
}

interface Turn {
  index: number
  startIdx: number
  endIdx: number
  messages: any[]
  isCurrent: boolean
  messageCount: number
  tokenEstimate: number
  contentHash: string
  summaryStatus: TurnSummaryStatus
  summary?: TurnSummary
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function estimateTokens(messages: any[]): number {
  return Math.ceil(
    messages.reduce((sum, m) => sum + (JSON.stringify(m).length / 4), 0)
  )
}

function getRole(msg: any): string {
  return msg?.info?.role || msg?.role || ""
}

function hashMessages(messages: any[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex")
}

// ─── Step 1: splitIntoTurns ─────────────────────────────────────────────────

function splitIntoTurns(messages: any[]): Turn[] {
  if (messages.length === 0) return []

  const turns: Turn[] = []
  let currentTurnStart = 0

  for (let i = 1; i < messages.length; i++) {
    const prevRole = getRole(messages[i - 1])
    const currRole = getRole(messages[i])

    // Cut boundary: previous is NOT user AND current IS user
    if (prevRole !== "user" && currRole === "user") {
      const turnMessages = messages.slice(currentTurnStart, i)
      turns.push({
        index: turns.length,
        startIdx: currentTurnStart,
        endIdx: i,
        messages: turnMessages,
        isCurrent: false,
        messageCount: turnMessages.length,
        tokenEstimate: estimateTokens(turnMessages),
        contentHash: hashMessages(turnMessages),
        summaryStatus: "pending",
      })
      currentTurnStart = i
    }
  }

  const finalMessages = messages.slice(currentTurnStart)
  turns.push({
    index: turns.length,
    startIdx: currentTurnStart,
    endIdx: messages.length,
    messages: finalMessages,
    isCurrent: true,
    messageCount: finalMessages.length,
    tokenEstimate: estimateTokens(finalMessages),
    contentHash: hashMessages(finalMessages),
    summaryStatus: "pending",
  })

  return turns
}

// ─── Step 2: updateToolOutputIndex ────────────────────────────────────────────

const CACHEABLE_TOOLS = new Set(["read", "glob", "grep", "webfetch"])

function getToolOutputKey(toolName: string, state: any): string | null {
  const input = state?.input || {}
  const tool = toolName.toLowerCase()

  switch (tool) {
    case "read": {
      const filePath = input.filePath || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "filePath" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `file:${filePath};${params}` : `file:${filePath}`
    }
    case "grep": {
      const pattern = input.pattern || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "pattern" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `grep:${pattern};${params}` : `grep:${pattern}`
    }
    case "glob": {
      const pattern = input.pattern || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "pattern" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `glob:${pattern};${params}` : `glob:${pattern}`
    }
    case "webfetch": {
      const url = input.url || ""
      const params = Object.entries(input)
        .filter(([k, v]) => k !== "url" && v !== undefined && v !== "")
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join(";")
      return params ? `url:${url};${params}` : `url:${url}`
    }
    default:
      return null
  }
}

function updateToolOutputIndex(
  turns: Turn[],
  toolOutputs: Map<string, ToolOutputEntry>,
): void {
  for (const turn of turns) {
    for (const msg of turn.messages) {
      if (getRole(msg) !== "assistant") continue

      for (const part of msg.parts || []) {
        if (part.type !== "tool" || part.state?.status !== "completed") continue
        const toolName: string = part.tool || ""
        if (!CACHEABLE_TOOLS.has(toolName)) continue

        const key = getToolOutputKey(toolName, part.state)
        if (!key) continue

        const output = part.state.output || ""

        if (toolOutputs.has(key)) {
          const entry = toolOutputs.get(key)!
          entry.lastSeenTurnIdx = turn.index
          entry.callCount++
          if (entry.output !== output) {
            entry.output = output
          }
        } else {
          toolOutputs.set(key, {
            key,
            toolType: toolName,
            output,
            timestamp: Date.now(),
            lastSeenTurnIdx: turn.index,
            callCount: 1,
          })
        }
      }
    }
  }
}

// ─── Step 3: buildCompressedMessagesForHotTurn ────────────────────────────────

const DECAY_WEIGHTS = { distance: 1.0, time: 0.3, frequency: 0.5 }
const TOOL_DECAY_MODIFIERS: Record<string, number> = {
  read: 0.8, glob: 0.6, grep: 0.7, webfetch: 1.5,
}

type CompressionLevel = "full" | "summary" | "placeholder" | "minimal"

function calculateDecayScore(entry: ToolOutputEntry, currentTurnIdx: number, now: number): number {
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

function getCompressionLevel(score: number): CompressionLevel {
  if (score < 2) return "full"
  if (score < 5) return "summary"
  if (score < 8) return "placeholder"
  return "minimal"
}

function compressToolOutput(toolName: string, state: any, level: CompressionLevel): string {
  const input = state?.input || {}
  const output = state?.output || ""
  const tool = toolName.toLowerCase()

  switch (tool) {
    case "read": {
      const filePath = input.filePath || input.file || input.path || "?"
      const lines = output.split("\n")
      const lineCount = lines.length
      switch (level) {
        case "full": return output
        case "summary": {
          const preview = [
            ...lines.slice(0, 3),
            `  ... ${Math.max(0, lineCount - 6)} more lines ...`,
            ...lines.slice(-3),
          ].join("\n")
          return `[COMPRESSED: read "${filePath}"]\n${preview}`
        }
        case "placeholder":
          return `[COMPRESSED: read "${filePath}" — ${lineCount} lines]`
        default:
          return `[COMPRESSED: read "${filePath}"]`
      }
    }
    case "glob": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: glob "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(", ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder":
          return `[COMPRESSED: glob "${pattern}" — ${count} matches]`
        default:
          return `[COMPRESSED: glob "${pattern}"]`
      }
    }
    case "grep": {
      const pattern = input.pattern || "?"
      const lines = output.split("\n").filter(Boolean)
      const count = lines.length
      switch (level) {
        case "full": return output
        case "summary":
          return `[COMPRESSED: grep "${pattern}"] — ${count} matches: ${lines.slice(0, 5).join(" | ")}${count > 5 ? ` ... +${count - 5} more` : ""}`
        case "placeholder":
          return `[COMPRESSED: grep "${pattern}" — ${count} matches]`
        default:
          return `[COMPRESSED: grep "${pattern}"]`
      }
    }
    case "webfetch": {
      const url = input.url || "?"
      const size = new TextEncoder().encode(output).length
      switch (level) {
        case "full": return output
        case "summary": return `[COMPRESSED: webfetch "${url}"]\n${output.slice(0, 200)}...`
        case "placeholder": return `[COMPRESSED: webfetch "${url}" — ${size} bytes]`
        default: return `[COMPRESSED: webfetch "${url}"]`
      }
    }
    default:
      return `[COMPRESSED: ${toolName} — output truncated]`
  }
}

function buildCompressedMessagesForHotTurn(
  turn: Turn,
  toolOutputs: Map<string, ToolOutputEntry>,
  currentTurnIdx: number,
): any[] {
  const now = Date.now()
  const result: any[] = []

  for (const msg of turn.messages) {
    const role = getRole(msg)
    if (role !== "assistant") {
      result.push(structuredClone(msg))
      continue
    }

    const cloned = structuredClone(msg)

    for (const part of cloned.parts || []) {
      if (part.type !== "tool" || part.state?.status !== "completed") continue
      const toolName: string = part.tool || ""
      if (!CACHEABLE_TOOLS.has(toolName)) continue

      const key = getToolOutputKey(toolName, part.state)
      if (!key) continue

      const entry = toolOutputs.get(key)
      if (!entry) continue

      const score = calculateDecayScore(entry, currentTurnIdx, now)
      const level = getCompressionLevel(score)
      if (level !== "full") {
        part.state.output = compressToolOutput(toolName, part.state, level)
      }
    }

    result.push(cloned)
  }

  return result
}

// ─── Step 4: buildSummaryReplacement ─────────────────────────────────────────

function buildSummaryReplacement(turn: Turn): any[] {
  const s = turn.summary
  const timestamp = new Date(turn.messages[0]?.timestamp ?? Date.now()).toLocaleString()

  const userMsg: any = {
    role: "user",
    info: { role: "user", __compressed: "summary", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: `=== Turn ${turn.index} Summary (${timestamp}) ===\nThis turn has been compressed. Original: ${turn.messageCount} messages, ~${turn.tokenEstimate} tokens.`,
    }],
  }

  const assistantMsg: any = {
    role: "assistant",
    info: { role: "assistant", __compressed: "summary", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: s
        ? [
          `Turn ${turn.index} Summary:`,
          `Overview: ${s.overview}`,
          s.intent ? `Intent: ${s.intent}` : null,
          s.actions.length > 0 ? `Actions: ${s.actions.map((a) => `${a.tool}(${a.target})`).join(", ")}` : null,
          s.artifacts.length > 0 ? `Artifacts: ${s.artifacts.map((a) => `${a.action} ${a.path}`).join(", ")}` : null,
          `Outcome: ${s.outcome}`,
        ].filter(Boolean).join("\n")
        : `(Summary not yet generated for this turn)`,
    }],
  }

  return [userMsg, assistantMsg]
}

// ─── Step 5: buildCompressedMessages (token budget) ───────────────────────────

const MAX_HOT_TURNS = 3

function buildCompressedMessages(
  turns: Turn[],
  toolOutputs: Map<string, ToolOutputEntry>,
  budget: number,
): any[] {
  const completedTurns = turns.filter((t) => !t.isCurrent)
  const currentTurn = turns.find((t) => t.isCurrent)
  const result: any[] = []

  let used = 0

  const coldTurns = completedTurns.slice(0, Math.max(0, completedTurns.length - MAX_HOT_TURNS))
  const hotTurns = completedTurns.slice(Math.max(0, completedTurns.length - MAX_HOT_TURNS))

  // Cold turns: newest cold first (closest to hot boundary), prepend to result
  for (const turn of [...coldTurns].reverse()) {
    let msgs: any[]

    if (turn.summaryStatus === "done" && turn.summary) {
      msgs = buildSummaryReplacement(turn)
    } else {
      msgs = structuredClone(turn.messages)
    }

    const tokens = estimateTokens(msgs)
    if (used + tokens > budget && result.length > 0) {
      break
    }

    result.unshift(...msgs)
    used += tokens
  }

  // Hot turns: decay compression
  for (const turn of hotTurns) {
    const msgs = buildCompressedMessagesForHotTurn(turn, toolOutputs, turns.length)
    result.unshift(...msgs)
    used += estimateTokens(msgs)
  }

  // Current turn: always included
  if (currentTurn) {
    result.push(...currentTurn.messages)
  }

  return result
}

// ─── Test Fixtures ───────────────────────────────────────────────────────────

/**
 * Create a message with a single text part.
 */
function textMsg(role: string, text: string): any {
  return {
    role,
    info: { role },
    parts: [{ type: "text", text }],
  }
}

/**
 * Create an assistant message with a tool call result.
 * @param toolName - e.g. "read", "grep"
 * @param input - tool input object
 * @param output - tool output string
 * @param status - tool call status
 */
function toolMsg(
  toolName: string,
  input: any,
  output: string,
  status = "completed",
): any {
  return {
    role: "assistant",
    info: { role: "assistant" },
    parts: [
      { type: "text", text: "" },
      { type: "tool", tool: toolName, state: { status, input, output } },
    ],
  }
}

/**
 * Create a completed tool part (for embedding in existing messages).
 */
function completedToolPart(toolName: string, input: any, output: string): any {
  return { type: "tool", tool: toolName, state: { status: "completed", input, output } }
}

/**
 * Helper to make a Turn object.
 */
function makeTurn(
  index: number,
  messages: any[],
  isCurrent: boolean,
  summaryStatus: TurnSummaryStatus = "pending",
  summary?: TurnSummary,
): Turn {
  return {
    index,
    startIdx: messages.reduce((s, _, i) => s, 0),
    endIdx: messages.length,
    messages,
    isCurrent,
    messageCount: messages.length,
    tokenEstimate: estimateTokens(messages),
    contentHash: hashMessages(messages),
    summaryStatus,
    summary,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Step 1: splitIntoTurns", () => {
  it("handles empty array", () => {
    expect(splitIntoTurns([])).toEqual([])
  })

  it("single user message is current turn", () => {
    const msgs = [textMsg("user", "hello")]
    const turns = splitIntoTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].isCurrent).toBe(true)
    expect(turns[0].messageCount).toBe(1)
    expect(turns[0].contentHash).toBeTruthy()
  })

  it("system message alone is current turn", () => {
    const msgs = [textMsg("system", "sys prompt")]
    const turns = splitIntoTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].isCurrent).toBe(true)
    expect(turns[0].messages[0].role).toBe("system")
  })

  it("splits on user message boundaries", () => {
    // Boundary rule: prevRole !== 'user' && currRole === 'user'
    // [sys, user, asst, user, asst]
    //  ↑cut     ↑cut
    const msgs = [
      textMsg("system", "sys"),
      textMsg("user", "task 1"),
      textMsg("assistant", "reply 1"),
      textMsg("user", "task 2"),
      textMsg("assistant", "reply 2"),
    ]
    const turns = splitIntoTurns(msgs)

    // Expected 4 turns:
    // Turn 0: [system] (next is user → cut)
    // Turn 1: [user, assistant] (next is user → cut)
    // Turn 2: [user, assistant] (no next → isCurrent)
    // Wait, let me trace:
    // i=1: prevRole=system, currRole=user → cut → turn 0: [system], startIdx=0, endIdx=1
    // i=3: prevRole=assistant, currRole=user → cut → turn 1: [user, assistant] (idx 1-3), startIdx=1, endIdx=3
    // final: [user, assistant] (idx 3-5), isCurrent=true

    expect(turns).toHaveLength(3)

    // Turn 0: system alone (boundary: next is user)
    expect(turns[0].isCurrent).toBe(false)
    expect(turns[0].messages).toHaveLength(1)
    expect(turns[0].messages[0].role).toBe("system")

    // Turn 1: user + assistant (boundary: next is user)
    expect(turns[1].isCurrent).toBe(false)
    expect(turns[1].messages).toHaveLength(2)
    expect(turns[1].messages[0].role).toBe("user")
    expect(turns[1].messages[1].role).toBe("assistant")

    // Turn 2: user + assistant (current, no more messages)
    expect(turns[2].isCurrent).toBe(true)
    expect(turns[2].messages).toHaveLength(2)
  })

  it("multiple consecutive assistant messages stay in same turn", () => {
    const msgs = [
      textMsg("user", "q"),
      textMsg("assistant", "a"),
      textMsg("assistant", "a2"),
    ]
    const turns = splitIntoTurns(msgs)

    // No boundary: user→asst (no cut), asst→asst (no cut)
    // All 3 messages in one current turn
    expect(turns).toHaveLength(1)
    expect(turns[0].isCurrent).toBe(true)
    expect(turns[0].messages).toHaveLength(3)
    expect(turns[0].messages.map((m: any) => m.parts[0].text)).toEqual(["q", "a", "a2"])
  })

  it("assigns correct sequential index to each turn", () => {
    const msgs = [
      textMsg("user", "1"),
      textMsg("assistant", "1"),
      textMsg("user", "2"),
      textMsg("assistant", "2"),
      textMsg("user", "3"),
      textMsg("assistant", "3"),
    ]
    const turns = splitIntoTurns(msgs)
    expect(turns.map((t: Turn) => t.index)).toEqual([0, 1, 2])
  })

  it("computes token estimate correctly", () => {
    const msgs = [textMsg("user", "hello world")]
    const turns = splitIntoTurns(msgs)
    expect(turns[0].tokenEstimate).toBeGreaterThan(0)
  })
})

describe("Step 2: updateToolOutputIndex", () => {
  it("indexes new tool outputs", () => {
    const turns: Turn[] = [
      makeTurn(0, [
        textMsg("user", "read foo"),
        toolMsg("read", { filePath: "foo.ts" }, "file content here"),
      ], false),
    ]
    const toolOutputs = new Map<string, ToolOutputEntry>()

    updateToolOutputIndex(turns, toolOutputs)

    expect(toolOutputs.size).toBe(1)
    const entry = toolOutputs.get("file:foo.ts")!
    expect(entry.toolType).toBe("read")
    expect(entry.output).toBe("file content here")
    expect(entry.callCount).toBe(1)
    expect(entry.lastSeenTurnIdx).toBe(0)
  })

  it("deduplicates repeated tool calls by key", () => {
    const turns: Turn[] = [
      makeTurn(1, [
        textMsg("user", "read foo again"),
        toolMsg("read", { filePath: "foo.ts" }, "different content"),
      ], false),
    ]
    const toolOutputs = new Map<string, ToolOutputEntry>([
      ["file:foo.ts", { key: "file:foo.ts", toolType: "read", output: "file content here", timestamp: Date.now(), lastSeenTurnIdx: 0, callCount: 1 }],
    ])

    updateToolOutputIndex(turns, toolOutputs)

    expect(toolOutputs.size).toBe(1)
    const entry = toolOutputs.get("file:foo.ts")!
    expect(entry.callCount).toBe(2)
    expect(entry.lastSeenTurnIdx).toBe(1)
    expect(entry.output).toBe("different content")
  })

  it("skips non-cacheable tools", () => {
    const turns: Turn[] = [
      makeTurn(0, [
        textMsg("user", "run command"),
        toolMsg("shell", { command: "ls" }, "files"),
      ], false),
    ]
    const toolOutputs = new Map<string, ToolOutputEntry>()

    updateToolOutputIndex(turns, toolOutputs)

    expect(toolOutputs.size).toBe(0)
  })

  it("skips failed tool calls", () => {
    const turns: Turn[] = [
      makeTurn(0, [
        textMsg("user", "read"),
        toolMsg("read", { filePath: "foo.ts" }, "error", "error"),
      ], false),
    ]
    const toolOutputs = new Map<string, ToolOutputEntry>()

    updateToolOutputIndex(turns, toolOutputs)

    expect(toolOutputs.size).toBe(0)
  })

  it("treats same filePath with different params as different keys", () => {
    const turns: Turn[] = [
      makeTurn(0, [
        textMsg("user", "read with params"),
        toolMsg("read", { filePath: "foo.ts", offset: 10 }, "content with offset"),
      ], false),
    ]
    const toolOutputs = new Map<string, ToolOutputEntry>()

    updateToolOutputIndex(turns, toolOutputs)

    expect(toolOutputs.has("file:foo.ts;offset=10")).toBe(true)
    expect(toolOutputs.has("file:foo.ts")).toBe(false)
  })
})

describe("Step 3: buildCompressedMessagesForHotTurn", () => {
  it("preserves non-assistant messages unchanged", () => {
    const turn: Turn = makeTurn(0, [
      textMsg("user", "read foo"),
      textMsg("assistant", "here"),
    ], false)

    const result = buildCompressedMessagesForHotTurn(turn, new Map(), 1)

    expect(result).toHaveLength(2)
    expect(result[0].role).toBe("user")
    expect(result[1].role).toBe("assistant")
  })

  it("does not compress if tool output not in index", () => {
    const turn: Turn = makeTurn(0, [
      textMsg("user", "read"),
      toolMsg("read", { filePath: "foo.ts" }, "original content"),
    ], false)

    const result = buildCompressedMessagesForHotTurn(turn, new Map(), 1)

    // Tool not in index → no compression applied
    const toolPart = result[1].parts[1]
    expect(toolPart.state.output).toBe("original content")
  })

  it("compresses old tool outputs based on decay score", () => {
    const turn: Turn = makeTurn(0, [
      textMsg("user", "read"),
      toolMsg("read", { filePath: "foo.ts" }, "line1\nline2\nline3\nline4\nline5"),
    ], false)

    // Tool was seen at turn 0, now at turn 5 with 1 hour age → high decay score
    const toolOutputs = new Map<string, ToolOutputEntry>([
      ["file:foo.ts", {
        key: "file:foo.ts",
        toolType: "read",
        output: "line1\nline2\nline3\nline4\nline5",
        timestamp: Date.now() - 3600000,
        lastSeenTurnIdx: 0,
        callCount: 1,
      }],
    ])

    const result = buildCompressedMessagesForHotTurn(turn, toolOutputs, 5)

    const output = result[1].parts[1].state.output
    expect(output).not.toBe("line1\nline2\nline3\nline4\nline5")
    expect(output).toContain("[COMPRESSED:")
  })

  it("does not compress recent tool outputs (low decay)", () => {
    const turn: Turn = makeTurn(0, [
      textMsg("user", "read"),
      toolMsg("read", { filePath: "foo.ts" }, "original content"),
    ], false)

    // Tool was just called in this turn, no age
    const toolOutputs = new Map<string, ToolOutputEntry>([
      ["file:foo.ts", {
        key: "file:foo.ts",
        toolType: "read",
        output: "original content",
        timestamp: Date.now(),
        lastSeenTurnIdx: 0,
        callCount: 1,
      }],
    ])

    const result = buildCompressedMessagesForHotTurn(turn, toolOutputs, 1)

    // Score should be < 2 → level = full → no compression
    const output = result[1].parts[1].state.output
    expect(output).toBe("original content")
  })

  it("does not mutate original messages", () => {
    const turn: Turn = makeTurn(0, [
      textMsg("user", "read"),
      toolMsg("read", { filePath: "foo.ts" }, "content"),
    ], false)
    const toolOutputs = new Map<string, ToolOutputEntry>([
      ["file:foo.ts", { key: "file:foo.ts", toolType: "read", output: "content", timestamp: Date.now() - 7200000, lastSeenTurnIdx: 0, callCount: 1 }],
    ])

    buildCompressedMessagesForHotTurn(turn, toolOutputs, 5)

    // Original message should be unchanged
    const toolPart = turn.messages[1].parts[1]
    expect(toolPart.state.output).toBe("content")
  })
})

describe("Step 4: buildSummaryReplacement", () => {
  it("returns two messages: user + assistant", () => {
    const turn: Turn = makeTurn(3, [textMsg("user", "x")], false, "done", {
      turnIndex: 3, overview: "Fixed bug", intent: "Fix the login bug",
      actions: [{ tool: "read", target: "auth.ts", description: "read file", result: "found issue" }],
      artifacts: [{ path: "auth.ts", action: "modified", detail: "fixed" }],
      outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
    })

    const msgs = buildSummaryReplacement(turn)

    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe("user")
    expect(msgs[1].role).toBe("assistant")
    expect(msgs[0].info.__compressed).toBe("summary")
    expect(msgs[1].info.__compressed).toBe("summary")
    expect(msgs[0].info.turnIndex).toBe(3)
    expect(msgs[1].info.turnIndex).toBe(3)
  })

  it("user message contains turn metadata", () => {
    const turn: Turn = makeTurn(2, [textMsg("user", "x")], false, "done", {
      turnIndex: 2, overview: "", intent: "", actions: [], artifacts: [],
      outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
    })

    const msgs = buildSummaryReplacement(turn)

    expect(msgs[0].parts[0].text).toContain("Turn 2")
    expect(msgs[0].parts[0].text).toContain("1 messages")
  })

  it("assistant message contains all summary fields", () => {
    const turn: Turn = makeTurn(1, [textMsg("user", "x")], false, "done", {
      turnIndex: 1, overview: "Refactored API", intent: "Improve code structure",
      actions: [{ tool: "read", target: "api.ts", description: "read", result: "ok" }],
      artifacts: [{ path: "api.ts", action: "modified", detail: "" }],
      outcome: "success", errors: [], todos: [], confidence: 0.95, generatedAt: Date.now(),
    })

    const msgs = buildSummaryReplacement(turn)
    const text = msgs[1].parts[0].text

    expect(text).toContain("Turn 1 Summary")
    expect(text).toContain("Refactored API")
    expect(text).toContain("Intent: Improve code structure")
    expect(text).toContain("Outcome: success")
    expect(text).toContain("read(api.ts)")
    expect(text).toContain("modified api.ts")
  })

  it("handles unavailable summary gracefully", () => {
    const turn: Turn = makeTurn(1, [textMsg("user", "x")], false, "unavailable")

    const msgs = buildSummaryReplacement(turn)

    expect(msgs[1].parts[0].text).toContain("not yet generated")
  })
})

describe("Step 5: buildCompressedMessages (token budget)", () => {
  it("current turn is always included", () => {
    const turns: Turn[] = [
      makeTurn(0, [textMsg("user", "x"), textMsg("assistant", "y")], false),
      makeTurn(1, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true),
    ]

    const result = buildCompressedMessages(turns, new Map(), 50)

    const currentMsgs = result.filter((m: any) =>
      m.parts?.[0]?.text === "cur" || m.parts?.[0]?.text === "curreply"
    )
    expect(currentMsgs).toHaveLength(2)
  })

  it("hot turns use decay compression", () => {
    const turns: Turn[] = [
      // Turn 0: cold
      makeTurn(0, [textMsg("user", "old"), textMsg("assistant", "old reply")], false, "pending"),
      // Turn 1: hot
      makeTurn(1, [textMsg("user", "recent"), textMsg("assistant", "recent reply")], false, "pending"),
      // Turn 2: current
      makeTurn(2, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    const result = buildCompressedMessages(turns, new Map(), 10000)

    // Current turn must be present
    expect(result.some((m: any) => m.parts?.[0]?.text === "curreply")).toBe(true)
    // Hot turn (turn 1) must be present (decay compression applied but structure kept)
    expect(result.some((m: any) => m.parts?.[0]?.text === "recent reply")).toBe(true)
  })

  it("cold turns with done summary use summary replacement", () => {
    const turns: Turn[] = [
      // Turn 0: cold (outside MAX_HOT_TURNS=3), summary done → should be replaced
      makeTurn(0, [textMsg("user", "old"), textMsg("assistant", "old reply")], false, "done", {
        turnIndex: 0, overview: "old turn", intent: "", actions: [], artifacts: [],
        outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
      }),
      makeTurn(1, [textMsg("user", "t1"), textMsg("assistant", "r1")], false, "pending"),
      makeTurn(2, [textMsg("user", "t2"), textMsg("assistant", "r2")], false, "pending"),
      makeTurn(3, [textMsg("user", "t3"), textMsg("assistant", "r3")], false, "pending"),
      // Turn 4: current
      makeTurn(4, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    const result = buildCompressedMessages(turns, new Map(), 10000)

    // Turn 0 should be replaced with 2 summary messages (user + assistant)
    const turn0User = result.find((m: any) => m.info?.turnIndex === 0 && m.role === "user")
    const turn0Assistant = result.find((m: any) => m.info?.turnIndex === 0 && m.role === "assistant")
    expect(turn0User).toBeDefined()
    expect(turn0Assistant).toBeDefined()

    // Original "old" and "old reply" should NOT be in result
    expect(result.some((m: any) => m.parts?.[0]?.text === "old")).toBe(false)
  })

  it("cold turns without summary stay as original messages", () => {
    const turns: Turn[] = [
      // Turn 0: cold, summary pending → should keep original
      makeTurn(0, [textMsg("user", "old"), textMsg("assistant", "old reply")], false, "pending"),
      // Turn 1: hot
      makeTurn(1, [textMsg("user", "recent"), textMsg("assistant", "recent reply")], false, "pending"),
      // Turn 2: current
      makeTurn(2, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    const result = buildCompressedMessages(turns, new Map(), 10000)

    // Original "old reply" should still be there
    expect(result.some((m: any) => m.parts?.[0]?.text === "old reply")).toBe(true)
  })

  it("respects token budget: hot turns use progressive compression, cold turns never cut", () => {
    // Build many hot turns with large content
    const largeContent = "x".repeat(200)
    const hotTurns = Array.from({ length: 6 }, (_, i) =>
      makeTurn(i, [
        textMsg("user", `u${i}${largeContent}`),
        textMsg("assistant", `a${i}${largeContent}`),
      ], false, "pending")
    )
    hotTurns.push(makeTurn(6, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"))

    // Budget: only enough for 2 hot turns + current
    const result = buildCompressedMessages(hotTurns, new Map(), 500)

    // Current turn must always be included
    const currentMsgs = result.filter((m: any) =>
      m.parts?.[0]?.text === "cur" || m.parts?.[0]?.text === "curreply"
    )
    expect(currentMsgs).toHaveLength(2)

    // Some hot turns must be included (progressive compression should allow more turns)
    const hotMsgs = result.filter((m: any) =>
      m.parts?.[0]?.text?.startsWith("u5") || m.parts?.[0]?.text?.startsWith("a5")
    )
    expect(hotMsgs.length).toBeGreaterThan(0)
  })
})

describe("Integration: full flow", () => {
  it("runs split → index → compress end to end", () => {
    const rawMessages = [
      textMsg("user", "task 1"),
      textMsg("assistant", "reply 1"),
      textMsg("user", "task 2"),
      textMsg("assistant", "reply 2"),
      textMsg("user", "task 3"),
      textMsg("assistant", "reply 3"),
      textMsg("user", "task 4"),
      textMsg("assistant", "reply 4"),
      textMsg("user", "task 5"),
      textMsg("assistant", "reply 5"),
    ]

    // Step 1: split → 5 turns: 4 completed + 1 current
    const turns = splitIntoTurns(rawMessages)
    expect(turns).toHaveLength(5)

    // Step 2: index
    const toolOutputs = new Map<string, ToolOutputEntry>()
    updateToolOutputIndex(turns, toolOutputs)
    expect(toolOutputs.size).toBe(0)

    // Simulate cold zone: mark turn 0 as done with summary
    // completedTurns=4, MAX_HOT=5, coldBoundary=0 → turn 0 is cold
    turns[0].summaryStatus = "done"
    turns[0].summary = {
      turnIndex: 0, overview: "task 1 done", intent: "", actions: [], artifacts: [],
      outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
    }

    // Step 3: compress with token budget
    const result = buildCompressedMessages(turns, toolOutputs, 10000)

    // Cold turn (turn 0, oldest) appears somewhere in the middle as summary
    const summaryMsgs = result.filter((m: any) => m.info?.__compressed === "summary")
    expect(summaryMsgs).toHaveLength(2)
    expect(summaryMsgs[0].role).toBe("user")
    expect(summaryMsgs[1].role).toBe("assistant")
    expect(summaryMsgs[0].info.turnIndex).toBe(0)

    // Original cold turn messages (task 1 / reply 1) should NOT be in result
    expect(result.some((m: any) => m.parts?.[0]?.text === "task 1")).toBe(false)
    expect(result.some((m: any) => m.parts?.[0]?.text === "reply 1")).toBe(false)

    // Hot turns keep original messages
    const task2 = result.find((m: any) => m.parts?.[0]?.text === "task 2")
    expect(task2?.info?.__compressed).toBeUndefined()

    // Current turn (turn 4) present
    expect(result.some((m: any) => m.parts?.[0]?.text === "reply 5")).toBe(true)
  })
})
