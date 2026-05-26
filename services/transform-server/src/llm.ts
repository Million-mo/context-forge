import type { LLMConfig, ParsedSummary, TurnSummary } from "./types.js"

// ─── Prompt Template ─────────────────────────────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `你是一个上下文压缩助手。请从对话轮次中提取关键信息，生成结构化摘要。

重要：你没有思考能力，不要输出任何思考过程、推理步骤或解释。直接输出 JSON 结果。

输出要求：
- overview 控制在 20 字以内
- actions 只记录关键步骤，跳过纯探索性调用（read/grep/glob 等），除非结果有特别发现
- artifacts 优先记录 modified/created，read 类型除非有重要发现否则省略
- confidence 反映摘要可信度：对话清晰=0.9, 模糊或结果截断=0.5
- 如果 outcome 不是 success，必须填写 reason 字段

严格按以下 JSON 格式输出，不可省略任何字段：`

const SUMMARY_USER_PROMPT = `请为以下对话轮次生成摘要：

<turn_messages>
{turn_content}
</turn_messages>

按此 JSON 格式直接输出（不要包含任何其他内容、思考过程或解释）：
{
  "overview": "一句话描述本轮做了什么+结果",
  "intent": "用户的核心需求",
  "actions": [{"tool": "工具名", "target": "操作对象", "description": "动作", "result": "结果"}],
  "artifacts": [{"path": "文件路径", "action": "created|modified|deleted|read", "detail": "变更说明"}],
  "outcome": "success|partial|failure|unknown",
  "errors": ["错误描述"],
  "todos": ["未完成事项"],
  "confidence": 0.0-1.0,
  "reason": "当 outcome!=success 或 confidence<0.7 时的解释"
}`

// ─── Message Serialization ───────────────────────────────────────────────────

/**
 * Serialize a list of messages into a readable string for the LLM.
 * Focuses on role, tool calls, and tool outputs.
 */
export function serializeMessages(messages: any[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const role = msg?.info?.role || msg?.role || "unknown"
    lines.push(`[${role.toUpperCase()}]`)

    // Text parts
    for (const part of msg.parts || []) {
      if (part.type === "text") {
        const text = (part.text || "").trim()
        if (text) lines.push(text)
      } else if (part.type === "tool") {
        const toolName = part.tool || "unknown"
        const state = part.state || {}
        const inputStr = JSON.stringify(state.input || {}, null, 2)
        const outputStr = (state.output || "").toString()

        lines.push(`--- tool_call: ${toolName}`)
        lines.push(`input: ${inputStr}`)

        // Truncate long outputs
        const MAX_OUTPUT_LINES = 60
        const outputLines = outputStr.split("\n")
        if (outputLines.length > MAX_OUTPUT_LINES) {
          lines.push(
            `output (truncated, ${outputLines.length} lines):`,
            ...outputLines.slice(0, MAX_OUTPUT_LINES),
            `... [${outputLines.length - MAX_OUTPUT_LINES} more lines]`,
          )
        } else {
          lines.push(`output: ${outputStr || "(empty)"}`)
        }
        lines.push("---")
      }
    }
  }

  return lines.join("\n")
}

// ─── LLM Client ──────────────────────────────────────────────────────────────

export interface LLMCallResult {
  summary: TurnSummary
  tokensUsed: number
  cached: boolean
}

export class LLMClient {
  private config: LLMConfig

  constructor(config: LLMConfig) {
    this.config = config
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.config.apiKey}`,
    }
  }

  private async callOpenAI(messages: any[]): Promise<{ content: string; usage?: { total_tokens: number } }> {
    const url = `${this.config.baseUrl || "https://api.openai.com"}/v1/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    let res: Response
    try {
      res = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
        }),
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${body}`)
    }

    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning || ""
    return {
      content: content,
      usage: data.usage,
    }
  }

  private async callAnthropic(messages: any[]): Promise<{ content: string; usage?: { input_tokens: number; output_tokens: number } }> {
    const url = `${this.config.baseUrl || "https://api.anthropic.com"}/v1/messages`
    const systemMsg = messages.find((m) => m.role === "system")
    const nonSystem = messages.filter((m) => m.role !== "system")

    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.buildHeaders(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: this.config.model,
        system: systemMsg?.content || undefined,
        messages: nonSystem,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Anthropic API error ${res.status}: ${body}`)
    }

    const data = await res.json() as any
    return {
      content: data.content?.[0]?.text || "",
      usage: data.usage,
    }
  }

  async generateSummary(
    turnIndex: number,
    messages: any[],
  ): Promise<LLMCallResult> {
    const serializedContent = serializeMessages(messages)

    const requestMessages = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: SUMMARY_USER_PROMPT.replace("{turn_content}", serializedContent) },
    ]

    let raw: string
    let usage: any

    if (this.config.provider === "anthropic") {
      const result = await this.callAnthropic(requestMessages)
      raw = result.content
      usage = result.usage
    } else {
      const result = await this.callOpenAI(requestMessages)
      raw = result.content
      usage = result.usage
    }

    const tokensUsed = usage?.total_tokens
      ?? (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)

    const parsed = this.parseResponse(raw)

    const summary: TurnSummary = {
      turnIndex,
      overview: parsed.overview,
      intent: parsed.intent,
      actions: parsed.actions,
      artifacts: parsed.artifacts,
      outcome: parsed.outcome,
      errors: parsed.errors,
      todos: parsed.todos,
      confidence: parsed.confidence,
      reason: parsed.reason,
      generatedAt: Date.now(),
      tokensUsed,
    }

    return { summary, tokensUsed, cached: false }
  }

  private parseResponse(raw: string): ParsedSummary {
    const defaultReturn: ParsedSummary = {
      overview: "(解析失败)",
      intent: "",
      actions: [],
      artifacts: [],
      outcome: "unknown",
      errors: [],
      todos: [],
      confidence: 0.1,
      reason: `LLM 返回格式无法解析: ${raw.slice(0, 200)}`,
    }

    // Extract JSON block
    const match = raw.match(/```json\s*([\s\S]*?)\s*```/) ?? raw.match(/(\{[\s\S]*\})/)
    if (!match) return defaultReturn

    try {
      const parsed = JSON.parse(match[1])

      return {
        overview: String(parsed.overview || "").slice(0, 100),
        intent: String(parsed.intent || ""),
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
        outcome: ["success", "partial", "failure", "unknown"].includes(parsed.outcome)
          ? parsed.outcome
          : "unknown",
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        confidence: Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0.5)),
        reason: parsed.reason,
      }
    } catch {
      return defaultReturn
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createLLMClient(llmConfig: LLMConfig): LLMClient | null {
  if (!llmConfig.apiKey) {
    console.warn("[LLM] No apiKey set — summary generation disabled")
    return null
  }

  return new LLMClient(llmConfig)
}
