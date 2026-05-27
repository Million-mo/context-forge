import { config } from "./config.js"

export interface RecallLLMConfig {
  provider: "openai" | "anthropic"
  model: string
  apiKey: string
  baseUrl: string
  maxTokens: number
  temperature: number
}

export class RecallLLMClient {
  private config: RecallLLMConfig

  constructor(cfg: RecallLLMConfig) {
    this.config = cfg
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.config.apiKey}`,
    }
  }

  private async callOpenAI(messages: any[]): Promise<{ content: string; usage?: { total_tokens: number } }> {
    const url = `${this.config.baseUrl}/v1/chat/completions`
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

  async generate(prompt: string): Promise<string> {
    const messages = [
      { role: "user", content: prompt }
    ]

    if (this.config.provider === "anthropic") {
      throw new Error("Anthropic not implemented for recall")
    }

    const result = await this.callOpenAI(messages)
    return result.content
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRecallLLMClient(): RecallLLMClient | null {
  const { llm } = config

  // Local/self-hosted LLM doesn't require API key; only anthropic always needs one
  if (!llm.apiKey && llm.provider === "anthropic") {
    console.warn("[recall-llm] No apiKey set for anthropic — recall generation disabled")
    return null
  }

  return new RecallLLMClient({
    provider: llm.provider,
    model: llm.model,
    apiKey: llm.apiKey,
    baseUrl: llm.baseUrl,
    maxTokens: llm.maxTokens,
    temperature: llm.temperature,
  })
}
