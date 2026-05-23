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

| Skill | Description |
|-------|-------------|
| `caveman` | Core compression mode skill (six intensity levels) |
| `cavecrew` | Decision guide for spawning caveman subagents |
| `caveman-commit` | Commit message generation |
| `caveman-review` | Code review |
| `caveman-compress` | Text compression |
| `caveman-help` | Help/guidance |

---

## Quick Start

```bash
cd ctx_plugin
npm install
npm run build

# Install all components (MCP server + plugin)
ctx_plugin install all

# Or pieces individually
ctx_plugin install mcp
ctx_plugin install plugin

# Check status
ctx_plugin status

# Run diagnostics
ctx_plugin doctor
```

Restart opencode after installation.

---

## CLI Reference

```bash
ctx_plugin install [mcp|plugin|all]    # Install components
ctx_plugin uninstall [mcp|plugin|all]   # Uninstall
ctx_plugin status                        # Show what's installed
ctx_plugin doctor                        # Diagnostics
ctx_plugin security                      # Show security policies
ctx_plugin purge [--days=N]              # Purge old sessions
```

---

## Architecture

```
context_forge/
├── README.md                  # This file
├── .opencode/                 # opencode workspace config
├── ctx_plugin/                # Core plugin
│   ├── README.md              # Full plugin documentation
│   ├── src/
│   │   ├── plugin.ts          # opencode plugin (RTK + Caveman hooks)
│   │   ├── cli.ts             # Install/uninstall/status CLI
│   │   ├── security.ts        # Policy engine + shell-escape scanner
│   │   ├── session-db.ts      # SQLite event store
│   │   ├── rtk.ts             # RTK rewrite integration
│   │   ├── mcp/
│   │   │   ├── server.ts      # MCP server (stdio)
│   │   │   ├── executor.ts    # PolyglotExecutor (sandbox code execution)
│   │   │   ├── runtime.ts     # Runtime detection
│   │   │   ├── store.ts       # FTS5 BM25 + trigram RRF search
│   │   │   └── types.ts       # Shared types
│   │   └── hooks/
│   │       ├── routing.ts     # Tool routing decisions
│   │       ├── guidance.ts    # Per-session guidance throttle
│   │       └── tool-naming.ts # Tool name normalization
│   └── skills/
│       ├── caveman/           # Six intensity levels
│       ├── cavecrew/          # Subagent delegation guide
│       ├── caveman-commit/    # Commit messages
│       ├── caveman-review/    # Code review
│       ├── caveman-compress/  # Text compression
│       └── caveman-help/      # Help skill
└── .deepseek/                 # DeepSeek workspace config
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
    "ctx_plugin": {
      "type": "local",
      "command": ["node", "/absolute/path/to/dist/mcp/server.js"]
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
