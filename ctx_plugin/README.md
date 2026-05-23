# ctx_plugin

Unified opencode plugin that merges three capabilities into one cohesive system:

- **RTK** — intercepts `bash`/`shell` tool calls and rewrites commands via `rtk rewrite`
- **Caveman** — ultra-compressed communication mode with session-level persistence
- **MCP Server** — sandboxed polyglot code execution + FTS5 full-text search

Source of truth lives in `src/plugin.ts`. A mirror is deployed to `.opencode/plugins/caveman.mjs` for runtime.

---

## Components

### MCP Server

Full [Model Context Protocol](https://modelcontextprotocol.io) server providing 10 tools:

| Tool | Description |
|------|-------------|
| `ctx_ping` | Health check |
| `ctx_execute` | Execute code in sandbox (11 languages, 100MB output cap) |
| `ctx_runtimes` | List available language runtimes |
| `ctx_index` | Index file or content into FTS5 store |
| `ctx_search` | BM25 + trigram RRF fusion search |
| `ctx_stats` | Content store statistics |
| `ctx_execute_file` | Execute a script file with sandboxed environment |
| `ctx_batch_execute` | Sequential or parallel batch execution |
| `ctx_fetch_and_index` | Fetch web content and index it |
| `ctx_purge` | Purge session data from SQLite store |

**Supported languages:** `javascript`, `typescript`, `python`, `shell`, `ruby`, `go`, `rust`, `php`, `perl`, `r`, `elixir`

TypeScript detection prefers `deno`; falls back to `npx tsx`. Python detection prefers `python3`.

The server runs as a stdio MCP server. Configuration is injected into `opencode.json` via `ctx_plugin install mcp`.

### RTK Integration

When `rtk` is available in PATH, the plugin intercepts `bash`/`shell` tool calls and passes commands through `rtk rewrite` before execution. This provides smarter command rewriting without changing agent behavior.

### Caveman Mode

Six compression intensity levels for every model response:

| Level | Compression |
|-------|------------|
| `lite` | Drop filler/hedging. Sentences stay full. |
| `full` | Drop articles, fragments OK, short synonyms. |
| `ultra` | Bare fragments. Abbreviations (DB, auth, fn). Arrows for causality. |
| `wenyan-lite` | Classical Chinese register, light compression. |
| `wenyan-full` | Maximum 文言文. 80-90% character reduction. |
| `wenyan-ultra` | Extreme classical compression. |

**Independent modes** (no persistence — fire once per invocation):
- `/caveman-commit` — commit message generation
- `/caveman-review` — code review
- `/caveman-compress` — compress provided text

### Security Policy

The plugin enforces a layered security model:

1. **Deny patterns** — `curl | sh`, `wget | sh`, `eval()` calls, `LD_PRELOAD`, `PYTHONSTARTUP`
2. **Allow patterns** — structural read-only commands (git status, ls, cat, npm ls, etc.)
3. **Ask** — anything not matched above, defaults to asking the user

Policy is loaded from `~/.config/opencode/settings.json` (or project-local `.opencode/settings.json`). Set `CTX_PLUGIN_REQUIRE_SECURITY=1` to fail-closed (deny on any policy match instead of ask).

Shell-escape calls are also scanned in non-shell code (`os.system`, `subprocess.run`, `exec()`, `system()`, `Command::new`, etc.) and blocked if they match deny patterns.

### Session DB

SQLite-backed event store for tool call history, session metadata, and persistent tool counters. Stored in `~/.local/share/ctx_plugin/sessions/` (configurable via `CTX_PLUGIN_DATA_DIR`).

---

## Installation

```bash
# Build first
npm run build

# Install all components
ctx_plugin install all

# Or install pieces individually
ctx_plugin install mcp       # MCP server only
ctx_plugin install plugin    # Plugin (RTK + Caveman) only
```

Restart opencode after installation.

---

## CLI Commands

```bash
ctx_plugin install [mcp|plugin|all]   Install components
ctx_plugin uninstall [mcp|plugin|all]  Uninstall components
ctx_plugin status                       Show installation status
ctx_plugin doctor                       Run diagnostics
ctx_plugin security                     Show active security policies
ctx_plugin purge [--days=N]             Purge old sessions
ctx_plugin purge --session=<id>         Delete specific session
ctx_plugin purge --dry-run              Preview purge without executing
```

---

## Configuration

### opencode.json (MCP server)

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

### settings.json (Security policy)

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
| `CTX_PLUGIN_VERBOSE` | `1` = emit debug logs to stderr |
| `CAVEMAN_DEFAULT_MODE` | Default caveman level (e.g. `full`) |
| `OPENCODE_CONFIG_DIR` | Override opencode config directory |
| `RTK_AVAILABLE` | (RTK runtime) Enable command rewriting |

### Caveman config

Caveman reads from `~/.config/caveman/config.json`:

```json
{
  "defaultMode": "full"
}
```

---

## Architecture

```
ctx_plugin/
├── src/
│   ├── plugin.ts          # opencode plugin (RTK + Caveman hooks)
│   ├── cli.ts             # install/uninstall/status CLI
│   ├── security.ts        # Policy engine + shell-escape scanner
│   ├── session-db.ts      # SQLite event store
│   ├── rtk.ts             # RTK rewrite integration
│   ├── mcp/
│   │   ├── server.ts      # MCP server entry point
│   │   ├── executor.ts    # PolyglotExecutor (sandbox code execution)
│   │   ├── runtime.ts     # Runtime detection (Node, Python, Go, etc.)
│   │   ├── store.ts       # ContentStore (FTS5 BM25 + trigram RRF)
│   │   ├── db-base.ts     # SQLite base (better-sqlite3 wrapper)
│   │   └── types.ts       # Shared type definitions
│   └── hooks/
│       ├── routing.ts     # Tool routing decisions
│       ├── guidance.ts    # Per-session one-shot guidance throttle
│       ├── tool-naming.ts # Tool name normalization
│       └── index.ts       # Re-exports
└── skills/
    ├── caveman/           # SKILL.md for each caveman intensity level
    ├── cavecrew/          # Multi-agent coordination
    ├── caveman-commit/    # Commit message generation
    ├── caveman-review/    # Code review
    ├── caveman-compress/  # Text compression
    └── caveman-help/      # Help/guidance skill
```

---

## Changelog

### v0.2.0
- Added `ctx_fetch_and_index` tool for web content indexing
- Added `ctx_doctor` tool for system diagnostics
- Improved BM25 + trigram RRF fusion search
- Added Rust compilation-and-run support
- Session DB with tool-call statistics and event logging
- Per-session guidance throttle (hybrid in-memory + atomic file)
- Comprehensive security policy engine with shell-escape detection

### v0.1.0
- Initial MCP server with code execution and FTS5 search
- RTK command rewriting integration
- Caveman communication mode
- opencode plugin hooks
