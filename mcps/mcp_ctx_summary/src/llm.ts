import { config } from "./config.js"
import type { LLMConfig } from "./config.js"

export class RecallLLMClient {
  private config: LLMConfig

  constructor(cfg: LLMConfig) {
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
    return { content, usage: data.usage }
  }

  async generate(prompt: string): Promise<string> {
    const messages = [{ role: "user", content: prompt }]

    if (this.config.provider === "anthropic") {
      throw new Error("Anthropic not implemented for recall")
    }

    const result = await this.callOpenAI(messages)
    return result.content
  }
}

export function createRecallLLMClient(): RecallLLMClient | null {
  const llm = config.llm

  if (!llm.apiKey) {
    console.warn("[recall-llm] No apiKey set — recall generation disabled")
    return null
  }

  return new RecallLLMClient(llm)
}
