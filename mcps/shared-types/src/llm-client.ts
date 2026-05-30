/**
 * Unified LLM client for Context Forge.
 *
 * Single OpenAI-compatible API client used by:
 *   - mcp_ctx_summary  (recall generation)
 *   - ctx_plugin       (turn summarization)
 *   - mcp_context_forge (future: combined usage)
 *
 * Features:
 *   - Config-driven (provider, model, baseUrl, apiKey, etc.)
 *   - AbortController timeout (default 60s)
 *   - Structured error returns (never throws from chat/generate)
 *   - Streaming not supported (RPC-style request/response is sufficient)
 */

import type { LLMConfig } from "./config.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatError {
  error: string;
  status?: number;
}

export type ChatResponse = ChatResult | ChatError;

// ─────────────────────────────────────────────────────────
// Client
// ─────────────────────────────────────────────────────────

export class OpenAIClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Send a full chat completion request with multiple messages.
   * Returns either a ChatResult or a ChatError — never throws.
   */
  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const url = `${this.config.baseUrl}/v1/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.config.model,
          messages,
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("abort") || message.includes("timeout")) {
        return { error: "LLM request timed out (60s)" };
      }
      return { error: `LLM request failed: ${message}` };
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        body = "(could not read response body)";
      }
      return {
        error: `LLM API error ${res.status}`,
        status: res.status,
      };
    }

    try {
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const content =
        data.choices?.[0]?.message?.content ||
        data.choices?.[0]?.message?.reasoning ||
        "";

      return {
        content,
        usage: data.usage
          ? {
              promptTokens: data.usage.prompt_tokens,
              completionTokens: data.usage.completion_tokens,
              totalTokens: data.usage.total_tokens,
            }
          : undefined,
      };
    } catch (err) {
      return { error: `Failed to parse LLM response: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Convenience — single user message, returns text content only.
   * On error, returns the error message as the content (caller can check).
   */
  async generate(prompt: string): Promise<string> {
    const response = await this.chat([{ role: "user", content: prompt }]);
    if ("error" in response) {
      return `[LLM error: ${response.error}]`;
    }
    return response.content;
  }
}

// ─────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────

/**
 * Create an OpenAIClient if the config has an API key.
 * Returns null if no key is configured (caller should handle gracefully).
 */
export function createLLMClient(config: LLMConfig): OpenAIClient | null {
  if (!config.apiKey || config.apiKey === "placeholder") {
    return null;
  }
  return new OpenAIClient(config);
}
