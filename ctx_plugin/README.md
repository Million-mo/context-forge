# ctx_plugin

Unified opencode plugin toolkit with three independent components:

| Component | Purpose | File |
|---|---|---|
| **RTK** | Intercepts `bash`/`shell` calls, rewrites via `rtk rewrite` | `src/rtk.ts` → `rtk.ts` |
| **Caveman** | Ultra-compressed communication mode with persistence | `src/caveman.ts` → `caveman.mjs` |
| **Routing** | Tool routing, security policy, guidance injection, shell env | `src/routing-plugin.ts` → `routing.mjs` |

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

### Routing Plugin

Tool routing, security policy enforcement, and per-session guidance injection:

1. **Security** — denies dangerous patterns (`curl | sh`, `eval()`, `LD_PRELOAD`), auto-grants safe commands
2. **Routing** — routes tool calls via `src/hooks/routing.ts`, injects guidance for large outputs / curl / build tools
3. **Shell env** — injects `CTX_PLUGIN_*` environment variables into all shell sessions
4. **RTK** — rewrites bash/shell commands via `rtk rewrite`

---

## Installation

```bash
# Build
cd ctx_plugin && npm install && npm run build

# Install all components
ctx_plugin install

# Install individually
ctx_plugin install caveman   # Caveman compression only
ctx_plugin install routing  # Routing + security only
ctx_plugin install --rtk   # RTK binary (auto-runs official installer)
```

---

## CLI Commands

```bash
ctx_plugin install [caveman|routing]   Install plugin
ctx_plugin uninstall [caveman|routing]  Uninstall plugin
ctx_plugin status                        Show installation status
ctx_plugin doctor                        Run diagnostics
ctx_plugin security                      Show active security policies
```

---

## Configuration

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
│   ├── caveman.ts            # Caveman opencode plugin
│   ├── routing-plugin.ts     # Routing + security opencode plugin
│   ├── rtk.ts                # Standalone RTK plugin
│   ├── cli.ts                # install/uninstall/status CLI
│   ├── security.ts           # Policy engine + shell-escape scanner
│   └── hooks/
│       ├── routing.ts        # Tool routing decisions
│       ├── guidance.ts       # Per-session one-shot guidance throttle
│       ├── tool-naming.ts    # Tool name normalization
│       └── index.ts          # Re-exports
├── bin/
│   ├── install.js             # Unified dispatcher
│   ├── install-rtk.js         # RTK install
│   ├── install-caveman.js      # Caveman install
│   └── install-routing.js     # Routing install
└── skills/
    ├── caveman/               # SKILL.md for each caveman intensity level
    ├── cavecrew/              # Multi-agent coordination
    ├── caveman-commit/
    ├── caveman-review/
    ├── caveman-compress/
    └── caveman-help/

.opencode/plugins/
├── caveman.mjs                # Runtime: Caveman plugin
├── routing.mjs                # Runtime: Routing plugin
└── rtk.ts                     # Runtime: RTK plugin (auto-scanned)
```

---

## Changelog

### v0.3.0
- **Split** `plugin.ts` into three independent plugins: `caveman.ts`, `routing-plugin.ts`, `rtk.ts`
- Each component now installable/removable independently
- Added `install-routing.js` and `--routing` CLI flag

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
