# context_forge

A workspace for building, experimenting with, and composing AI coding assistant plugins. Currently focused on the `ctx_plugin` system — a unified opencode plugin that brings three capabilities together.

---

## What's Inside

### ctx_plugin

The core project. A unified opencode plugin combining:

- **RTK** — intercepts `bash`/`shell` tool calls and rewrites commands via `rtk rewrite` before execution
- **Caveman** — ultra-compressed communication mode with session-level persistence across six intensity levels, from casual tight prose to 文言文 classical Chinese
- **MCP Server** — sandboxed polyglot code execution (11 languages) + FTS5 full-text search with BM25 + trigram RRF fusion

It also ships a SQLite-backed session event store, a layered security policy engine (deny/allow patterns + shell-escape scanning), and per-session guidance throttling.

See [ctx_plugin/README.md](ctx_plugin/README.md) for full details.

### Skills

Located under `ctx_plugin/skills/`:

| Skill | Type | Description |
|-------|------|-------------|
| `caveman` | 核心 | 每次回复压缩风格，减少 ~65-75% token 输出 |
| `cavecrew` | 核心 | 子 agent 决策：何时派发给 caveman 风格的 subagent |
| `caveman-commit` | 按需 | Commit message 生成（`/caveman-commit`） |
| `caveman-review` | 按需 | Code review（`/caveman-review`） |
| `caveman-compress` | 按需 | 文本压缩（`/caveman-compress`） |
| `caveman-help` | 按需 | 帮助/引导 |

**推荐配置**：至少保留 `caveman` + `cavecrew`，其他按需手动激活。

---

## MCP Servers

Located under `mcps/`:

| Package | Description |
|---------|-------------|
| `mcp_ctx_tool` | Sandboxed code execution (11 languages) + FTS5 content indexing/search |
| `mcp_ctx_summary` | Intent-driven recall + FTS search over session summaries |

Both are registered into `opencode.json` via their respective `install.js` scripts.

---

## Quick Start

```bash
# Build all MCP packages
cd mcps/mcp_ctx_tool && npm install && npm run build
cd mcps/mcp_ctx_summary && npm install && npm run build

# Install both MCP servers into opencode.json
npx tsx scripts/install-all.ts

# Or individually
node mcps/mcp_ctx_tool/dist/install.js
node mcps/mcp_ctx_summary/dist/install.js
```

Restart opencode after installation.

---

## Architecture

```
context_forge/
├── README.md                  # This file
├── .opencode/                 # opencode workspace config
├── mcps/                     # MCP server packages
│   ├── mcp_ctx_tool/         # Code execution + FTS5 search
│   │   └── src/
│   │       ├── server.ts      # MCP stdio server
│   │       ├── executor.ts    # PolyglotExecutor (sandbox code execution)
│   │       ├── runtime.ts     # Runtime detection
│   │       ├── store.ts       # FTS5 BM25 + trigram RRF search
│   │       ├── session-db.ts   # SQLite session event store
│   │       └── db-base.ts     # SQLite base wrapper
│   ├── mcp_ctx_summary/      # Context summary + recall
│   │   └── src/
│   │       ├── server.ts      # MCP stdio server
│   │       ├── llm.ts         # Recall LLM client
│   │       └── recall-prompts.ts
│   └── shared-types/         # Shared TypeScript types
├── ctx_plugin/               # Core opencode plugin
│   ├── README.md              # Full plugin documentation
│   ├── src/
│   │   ├── plugin.ts          # opencode plugin (RTK + Caveman hooks)
│   │   ├── cli.ts            # Install/uninstall/status CLI
│   │   ├── security.ts       # Policy engine + shell-escape scanner
│   │   └── hooks/
│   │       ├── routing.ts     # Tool routing decisions
│   │       ├── guidance.ts   # Per-session guidance throttle
│   │       └── tool-naming.ts
│   └── skills/
│       ├── caveman/          # Six intensity levels
│       ├── cavecrew/         # Subagent delegation guide
│       ├── caveman-commit/
│       ├── caveman-review/
│       ├── caveman-compress/
│       └── caveman-help/
└── scripts/
    └── install-all.ts         # One-shot MCP installer
```

---

## Requirements

- [opencode](https://github.com/opencode-ai/opencode)
- Node.js ≥ 18 or Bun
- (Optional) [RTK](https://github.com/rtk-ai/tinykt) for command rewriting

---

## Configuration

### MCP Server (`opencode.json`)

```json
{
  "mcp": {
    "mcp_ctx_tool": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcps/mcp_ctx_tool/dist/server.js"]
    },
    "mcp_ctx_summary": {
      "type": "local",
      "command": ["node", "/absolute/path/to/mcps/mcp_ctx_summary/dist/server.js"]
    }
  }
}
```

### Security Policy (`settings.json`)

```json
{
  "permissions": {
    "allow": ["Bash(pwd)", "Bash(git status)"],
    "deny": ["Bash(sudo *)"],
    "ask": []
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `CTX_PLUGIN_REQUIRE_SECURITY` | `1` = fail-closed on policy match |
| `CTX_PLUGIN_DATA_DIR` | Override session DB base directory |
| `CTX_PLUGIN_VERBOSE` | `1` = emit debug logs |
| `CAVEMAN_DEFAULT_MODE` | Default caveman level (`full`, `ultra`, `wenyan`, etc.) |
| `OPENCODE_CONFIG_DIR` | Override opencode config directory |
