# @context-forge/types

Shared TypeScript type definitions and prompt strings for the Context Forge MCP ecosystem.

## What's in here

This package contains the canonical type definitions used across:

- `services/ctx_summary_mcp/` — Summary MCP server (reads summaries)
- `.opencode/plugins/transform.ts` — Transform plugin (writes summaries)

### Summary Types

| Type | Description |
|------|-------------|
| `TurnSummary` | Structured summary of a conversation turn |
| `StoredMessage` | A message stored in the summaries DB |
| `ToolCall` | Tool invocation with serialized input/output |
| `ActionEntry` | Action taken (tool, target, description, result) |
| `ArtifactChange` | File change (path, action, detail) |
| `OutcomeType` | `"success" \| "partial" \| "failure" \| "unknown"` |
| `ArtifactAction` | `"created" \| "modified" \| "deleted" \| "read"` |

### Recall Types

| Type | Description |
|------|-------------|
| `RecallOptions` | Options for recall queries |
| `RecallResult` | Result set from a recall query |
| `RecallItem` | Single recalled turn |
| `SummaryWithSession` | TurnSummary with session ID |

### Prompts

`@context-forge/types/prompts` exports:
- `SUMMARY_SYSTEM_PROMPT` — System prompt for LLM turn summarization
- `SUMMARY_USER_PROMPT` — User prompt template with `{turn_content}` placeholder
- `MAX_SERIALIZED_SIZE` — Maximum serialized message size (50,000 chars)

## Usage

```bash
npm install
npm run build
```

```typescript
import type {
  TurnSummary,
  StoredMessage,
  RecallOptions,
  RecallResult,
} from "@context-forge/types"

import {
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_USER_PROMPT,
  MAX_SERIALIZED_SIZE,
} from "@context-forge/types/prompts"
```

## Build

```bash
npm run build   # compiles src/ → dist/
npm run typecheck  # type-check without emitting
```
