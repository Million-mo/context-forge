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

/**
 * New compression logic:
 * 1. Reserve space for current turn
 * 2. Process turns from newest to oldest, keeping as many as possible with decay
 * 3. For older turns that don't fit, replace with summary or placeholder
 * 4. Current turn is always included at the end
 */
function buildCompressedMessages(
  turns: Turn[],
  toolOutputs: Map<string, ToolOutputEntry>,
  budget: number,
): any[] {
  const completedTurns = turns.filter((t) => !t.isCurrent)
  const currentTurn = turns.find((t) => t.isCurrent)

  // Reserve space for current turn
  const reservedForCurrent = currentTurn ? estimateTokens(currentTurn.messages) : 0
  const availableBudget = budget - reservedForCurrent

  if (availableBudget <= 0) {
    // Not enough space even for current turn
    return currentTurn ? [...currentTurn.messages] : []
  }

  // Process turns from newest to oldest, keeping as many as possible
  const keptMessages: any[] = []
  const replacedTurns: Turn[] = []
  let usedTokens = 0

  // Reverse iteration: newest first
  for (const turn of [...completedTurns].reverse()) {
    const compressed = buildCompressedMessagesForHotTurn(turn, toolOutputs, turns.length)
    const tokens = estimateTokens(compressed)

    if (usedTokens + tokens <= availableBudget) {
      // Can fit - keep this turn (prepend to result later)
      keptMessages.unshift(...compressed)
      usedTokens += tokens
    } else {
      // Can't fit - mark for replacement
      replacedTurns.unshift(turn)
    }
  }

  // Now replace old turns with summaries from front (oldest) to back
  const result: any[] = []
  for (const turn of replacedTurns) {
    if (turn.summaryStatus === "done" && turn.summary) {
      result.push(...buildSummaryReplacement(turn))
    } else {
      result.push(...buildPlaceholderReplacement(turn))
    }
  }

  // Add kept messages (recent turns with decay)
  result.push(...keptMessages)

  // Add current turn at the end
  if (currentTurn) {
    result.push(...currentTurn.messages)
  }

  return result
}

function buildPlaceholderReplacement(turn: Turn): any[] {
  return [{
    role: "user",
    info: { role: "user", __compressed: "placeholder", turnIndex: turn.index },
    parts: [{
      type: "text",
      text: `=== Turn ${turn.index} (${turn.messageCount} messages, ~${turn.tokenEstimate} tokens) ===\n[Compressed]`,
    }],
  }]
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

  it("under budget: all completed turns use decay compression", () => {
    const turns: Turn[] = [
      makeTurn(0, [textMsg("user", "old"), textMsg("assistant", "old reply")], false, "pending"),
      makeTurn(1, [textMsg("user", "recent"), textMsg("assistant", "recent reply")], false, "pending"),
      makeTurn(2, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    // Budget is generous (10000 tokens), all turns should be included with decay
    const result = buildCompressedMessages(turns, new Map(), 10000)

    // All messages should be present
    expect(result.some((m: any) => m.parts?.[0]?.text === "old reply")).toBe(true)
    expect(result.some((m: any) => m.parts?.[0]?.text === "recent reply")).toBe(true)
    expect(result.some((m: any) => m.parts?.[0]?.text === "curreply")).toBe(true)
  })

  it("over budget: oldest turns replaced with summaries from front to back", () => {
    // Use large content to ensure we exceed the budget
    const largeContent = "content ".repeat(100) // ~700 chars

    const turns: Turn[] = [
      // Turn 0: oldest, with summary done
      makeTurn(0, [textMsg("user", "old" + largeContent), textMsg("assistant", "old reply" + largeContent)], false, "done", {
        turnIndex: 0, overview: "old turn", intent: "", actions: [], artifacts: [],
        outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
      }),
      // Turn 1: with summary done
      makeTurn(1, [textMsg("user", "t1" + largeContent), textMsg("assistant", "r1" + largeContent)], false, "done", {
        turnIndex: 1, overview: "turn 1", intent: "", actions: [], artifacts: [],
        outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
      }),
      // Turn 2: most recent, no summary
      makeTurn(2, [textMsg("user", "recent"), textMsg("assistant", "recent reply")], false, "pending"),
      // Turn 3: current
      makeTurn(3, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    // Small budget - only current + recent fits
    const result = buildCompressedMessages(turns, new Map(), 500)

    // Turn 0 should be replaced with summary (oldest, over budget)
    const turn0User = result.find((m: any) => m.info?.turnIndex === 0 && m.role === "user")
    const turn0Assistant = result.find((m: any) => m.info?.turnIndex === 0 && m.role === "assistant")
    expect(turn0User).toBeDefined()
    expect(turn0Assistant).toBeDefined()
    expect(turn0User?.info?.__compressed).toBe("summary")

    // Original large content should NOT be in result
    expect(result.some((m: any) => m.parts?.[0]?.text?.includes("old" + largeContent.slice(0, 10)))).toBe(false)

    // Current turn must always be included
    expect(result.some((m: any) => m.parts?.[0]?.text === "curreply")).toBe(true)
  })

  it("turns without summary use placeholder when forced to compress", () => {
    // Use large content
    const largeContent = "content ".repeat(100)

    const turns: Turn[] = [
      // Turn 0: oldest, no summary
      makeTurn(0, [textMsg("user", "old" + largeContent), textMsg("assistant", "old reply" + largeContent)], false, "pending"),
      // Turn 1: with summary
      makeTurn(1, [textMsg("user", "t1"), textMsg("assistant", "r1")], false, "done", {
        turnIndex: 1, overview: "turn 1", intent: "", actions: [], artifacts: [],
        outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
      }),
      // Turn 2: current
      makeTurn(2, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    // Very small budget - forces turn 0 to be compressed
    const result = buildCompressedMessages(turns, new Map(), 300)

    // Turn 0 should be replaced with placeholder (no summary available)
    const turn0User = result.find((m: any) => m.info?.turnIndex === 0 && m.role === "user")
    expect(turn0User?.info?.__compressed).toBe("placeholder")

    // Original large content should NOT be in result
    expect(result.some((m: any) => m.parts?.[0]?.text?.includes("old" + largeContent.slice(0, 10)))).toBe(false)

    // Current turn must be included
    expect(result.some((m: any) => m.parts?.[0]?.text === "curreply")).toBe(true)
  })

  it("respects token budget: progressive compression from oldest", () => {
    // Build many turns with content that varies in size
    const smallContent = "x"
    const largeContent = "x".repeat(500)

    const turns: Turn[] = [
      makeTurn(0, [textMsg("user", "u0" + smallContent), textMsg("assistant", "a0" + smallContent)], false, "done", {
        turnIndex: 0, overview: "t0", intent: "", actions: [], artifacts: [],
        outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
      }),
      makeTurn(1, [textMsg("user", "u1" + largeContent), textMsg("assistant", "a1" + largeContent)], false, "pending"),
      makeTurn(2, [textMsg("user", "u2" + largeContent), textMsg("assistant", "a2" + largeContent)], false, "pending"),
      makeTurn(3, [textMsg("user", "cur"), textMsg("assistant", "curreply")], true, "pending"),
    ]

    // Budget: only enough for current + some turns
    const result = buildCompressedMessages(turns, new Map(), 400)

    // Current turn must always be included
    expect(result.some((m: any) => m.parts?.[0]?.text === "curreply")).toBe(true)

    // Some older content must be compressed/replaced
    // Turn 0 with summary should be compressed first
    expect(result.some((m: any) => m.parts?.[0]?.text === "u0")).toBe(false)
  })
})

describe("Integration: full flow", () => {
  it("runs dedup → split → compress end to end", () => {
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

    // Mark turn 0 as done with summary (oldest, most likely to be compressed)
    turns[0].summaryStatus = "done"
    turns[0].summary = {
      turnIndex: 0, overview: "task 1 done", intent: "", actions: [], artifacts: [],
      outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
    }

    // Step 3: compress with generous budget - all turns included with decay
    const result = buildCompressedMessages(turns, toolOutputs, 10000)

    // All original messages should be present (under budget)
    expect(result.some((m: any) => m.parts?.[0]?.text === "task 1")).toBe(true)
    expect(result.some((m: any) => m.parts?.[0]?.text === "reply 1")).toBe(true)
    expect(result.some((m: any) => m.parts?.[0]?.text === "reply 5")).toBe(true)

    // Current turn present
    expect(result.some((m: any) => m.parts?.[0]?.text === "reply 5")).toBe(true)
  })

  it("under budget: oldest turns with summaries get compressed first", () => {
    // Use large content to ensure budget is exceeded
    const largeContent = "content ".repeat(100)

    const rawMessages = [
      textMsg("user", "task 1" + largeContent),
      textMsg("assistant", "reply 1" + largeContent),
      textMsg("user", "task 2" + largeContent),
      textMsg("assistant", "reply 2" + largeContent),
      textMsg("user", "task 3"),
      textMsg("assistant", "reply 3"),
    ]

    const turns = splitIntoTurns(rawMessages)
    expect(turns).toHaveLength(3)

    // Mark oldest turn as done
    turns[0].summaryStatus = "done"
    turns[0].summary = {
      turnIndex: 0, overview: "task 1 done", intent: "", actions: [], artifacts: [],
      outcome: "success", errors: [], todos: [], confidence: 0.9, generatedAt: Date.now(),
    }

    const toolOutputs = new Map<string, ToolOutputEntry>()

    // Small budget forces compression of oldest turn
    const result = buildCompressedMessages(turns, toolOutputs, 500)

    // Turn 0 should be replaced with summary
    const summaryMsgs = result.filter((m: any) => m.info?.__compressed === "summary")
    expect(summaryMsgs).toHaveLength(2)
    expect(summaryMsgs[0].info.turnIndex).toBe(0)

    // Original large content should NOT be in result
    expect(result.some((m: any) => m.parts?.[0]?.text?.includes("task 1" + largeContent.slice(0, 10)))).toBe(false)

    // Recent turns should be present
    expect(result.some((m: any) => m.parts?.[0]?.text?.includes("task 2"))).toBe(true)

    // Current turn (turn 2) present
    expect(result.some((m: any) => m.parts?.[0]?.text === "reply 3")).toBe(true)
  })

  it("current turn is always last in result", () => {
    const rawMessages = [
      textMsg("user", "old"),
      textMsg("assistant", "old reply"),
      textMsg("user", "new"),
      textMsg("assistant", "new reply"),
    ]

    const turns = splitIntoTurns(rawMessages)
    const result = buildCompressedMessages(turns, new Map(), 100)

    // Find "new reply" (current turn's assistant message)
    const currentAssistantIdx = result.findIndex((m: any) =>
      m.parts?.[0]?.text === "new reply"
    )

    // It should be the last message
    expect(currentAssistantIdx).toBe(result.length - 1)
  })
})
