import type { StoredMessage, TurnSummary } from "@context-forge/shared-types"

export { SUMMARY_SYSTEM_PROMPT, SUMMARY_USER_PROMPT, MAX_SERIALIZED_SIZE } from "@context-forge/shared-types/prompts"

export const RECALL_SYSTEM_PROMPT = `You are a memory recall assistant. Given a conversation turn and a query, recall the most relevant information that answers the user's question.

Focus on:
- Key decisions and their rationale
- Problems encountered and how they were solved
- Important code changes or file modifications
- Relevant excerpts from the conversation

Be concise but comprehensive. Output directly without any prefix or explanation.`

export function buildRecallPrompt(params: {
  query: string
  summary: TurnSummary
  messages: StoredMessage[]
}): string {
  const { query, summary, messages } = params

  const conversationText = messages.map((msg, idx) => {
    let header = `[${idx}] ${msg.role.toUpperCase()}`
    if (msg.toolCalls?.length) {
      header += ` (tools: ${msg.toolCalls.map(t => t.name).join(", ")})`
    }

    let body = msg.content
    if (msg.toolCalls) {
      body += "\n\nTool calls:\n" + msg.toolCalls.map(t =>
        `  - ${t.name}: ${t.input}${t.output ? `\n    Output: ${t.output.slice(0, 200)}${t.output.length > 200 ? "..." : ""}` : ""}`
      ).join("\n")
    }

    return `${header}\n${body}`
  }).join("\n\n---\n\n")

  return `${RECALL_SYSTEM_PROMPT}

QUERY: "${query}"

CONTEXT:
- Intent: ${summary.intent}
- Outcome: ${summary.outcome}
- Overview: ${summary.overview}
${summary.actions.length > 0 ? `- Actions: ${summary.actions.map(a => `${a.tool} ${a.target}`).join(", ")}` : ""}
${summary.artifacts.length > 0 ? `- Artifacts: ${summary.artifacts.map(a => `${a.action} ${a.path}`).join(", ")}` : ""}

CONVERSATION:
${conversationText}

---

Recall (output directly to answer the query):
`
}

export function formatMessages(messages: StoredMessage[]): string {
  return messages.map((msg, idx) => {
    let line = `[${idx}] ${msg.role.toUpperCase()}: `
    if (msg.toolCalls?.length) {
      line += `(tools: ${msg.toolCalls.map(t => t.name).join(", ")}) `
    }
    line += msg.content.slice(0, 500)
    if (msg.content.length > 500) line += "..."
    return line
  }).join("\n")
}
