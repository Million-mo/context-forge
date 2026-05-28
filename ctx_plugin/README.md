# ctx_plugin

Unified opencode plugin that merges two capabilities:

- **RTK** — intercepts `bash`/`shell` tool calls and rewrites commands via `rtk rewrite`
- **Caveman** — ultra-compressed communication mode with session-level persistence

Source of truth lives in `src/plugin.ts`. A mirror is deployed to `.opencode/plugins/caveman.mjs` for runtime.

> **Note:** MCP servers have moved to `mcps/`. See `mcps/mcp_ctx_tool` (code execution + search) and `mcps/mcp_ctx_summary` (context summary + recall).

---

## Components

### RTK Integration

When `rtk` is available in PATH, the plugin intercepts `bash`/`shell` tool calls and passes commands through `rtk rewrite` before execution.

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

Policy is loaded from `~/.config/opencode/settings.json`. Set `CTX_PLUGIN_REQUIRE_SECURITY=1` to fail-closed.

---

## Installation

```bash
# Build
cd ctx_plugin && npm install && npm run build

# Install plugin
ctx_plugin install plugin
```

---

## CLI Commands

```bash
ctx_plugin install [plugin]   Install plugin
ctx_plugin uninstall [plugin]  Uninstall plugin
ctx_plugin status              Show installation status
ctx_plugin doctor              Run diagnostics
ctx_plugin security            Show active security policies
```

---

## Configuration

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
| `CTX_PLUGIN_VERBOSE` | `1` = emit debug logs to stderr |
| `CAVEMAN_DEFAULT_MODE` | Default caveman level (e.g. `full`) |
| `OPENCODE_CONFIG_DIR` | Override opencode config directory |

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
│   └── hooks/
│       ├── routing.ts     # Tool routing decisions
│       ├── guidance.ts    # Per-session one-shot guidance throttle
│       ├── tool-naming.ts # Tool name normalization
│       └── index.ts       # Re-exports
└── skills/
    ├── caveman/           # SKILL.md for each caveman intensity level
    ├── cavecrew/          # Multi-agent coordination
    ├── caveman-commit/
    ├── caveman-review/
    ├── caveman-compress/
    └── caveman-help/
```

---

## Changelog

### v0.2.0
- Added `ctx_fetch_and_index` tool for web content indexing
- Added `ctx_doctor` tool for system diagnostics
- Improved BM25 + trigram RRF fusion search
- Added Rust compilation-and-run support
- Session DB with tool-call statistics and event logging
- Per-session guidance throttle

### v0.1.0
- Initial MCP server with code execution and FTS5 search
- RTK command rewriting integration
- Caveman communication mode
- opencode plugin hooks
