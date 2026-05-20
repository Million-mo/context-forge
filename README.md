# Context Forge

macOS-first terminal installer for [RTK](https://github.com/rtk-ai/rtk) and [Caveman](https://github.com/JuliusBrussee/caveman).

Plugin-first design: pick a plugin, choose an action, run it. Each plugin owns its full lifecycle (install / uninstall / upgrade). RTK AI-tool integration is a natural sub-step, not a global setting.

## Quick Start

```bash
cargo run
# or
cargo run -- init
# or install globally
cargo install --path .
context-forge init
```

## Commands

```
context-forge              Launch TUI (default)
context-forge init         Same
context-forge gain [..]    Show RTK token savings (passes all args to rtk gain)
context-forge --help       Help
```

### `gain` — RTK token savings

Transparent proxy for `rtk gain`. All options supported:

```bash
context-forge gain                  # summary
context-forge gain --graph          # ASCII chart of daily savings
context-forge gain --history        # recent command history
context-forge gain --quota          # monthly quota savings estimate
context-forge gain --daily          # detailed daily breakdown
context-forge gain --weekly         # weekly breakdown
context-forge gain --monthly        # monthly breakdown
context-forge gain --all            # daily + weekly + monthly
context-forge gain --project        # filter to current project
context-forge gain --format json    # JSON output
context-forge gain --tier pro       # subscription tier: pro, 5x, 20x
context-forge gain --reset --yes    # reset all stats
```

## Flow

```
PluginSelection (RTK / Caveman)
  → ActionSelection (Install / Uninstall / Upgrade)
    → [RTK] AIToolSelection (pick AI tools: Claude, Cursor, etc.)
    → Scanning → Plan Summary → Execute → Results
```

## Features

- **Plugin-first**: pick RTK or Caveman first, then choose what to do
- **Multi-method install**: cargo → brew → curl install script, with automatic fallback
- **Observable steps**: each install method is a visible step with live output
- **Uninstall cleans up properly**: `rtk init -g --uninstall` + binary removal + config cleanup
- **RTK AI tool integration**: configure Claude Code, Cursor, Windsurf, Cline, and 7+ others
- **Token stats on startup**: PluginSelection shows `rtk gain` summary when RTK is installed

## TUI Shortcuts

| Page | Keys |
|------|------|
| Plugin/Action selection | `↑↓` pick, `Space` toggle, `Enter` continue |
| AI tool selection | `↑↓` pick, `Space` toggle, `Esc` back, `Enter` continue |
| Plan summary | `Enter` execute, `Esc` back |
| Results | `Esc` back to plugins |
| Anywhere | `q` quit |

## Development

```bash
cargo run          # dev mode
cargo test         # run tests
cargo build --release  # release binary at target/release/context-forge
```
