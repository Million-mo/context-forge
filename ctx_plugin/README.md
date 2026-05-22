# ctx_plugin

RTK + Caveman for [opencode](https://github.com/opencode-ai/opencode) — two plugins that work better together.

## Install

```bash
ctx_plugin install        # both RTK + Caveman
ctx_plugin install --rtk  # RTK bash-rewrite plugin only
ctx_plugin install --caveman  # Caveman skills + agents only
```

## Commands

### `ctx_plugin install`

Installs plugins into opencode's config directory.

| Flag | Effect |
|------|--------|
| `--all` | RTK + Caveman (default) |
| `--rtk` | RTK plugin only |
| `--caveman` | Caveman skills + agents only |
| `--force` | Overwrite existing files |

### `ctx_plugin uninstall`

Remove installed plugins.

```bash
ctx_plugin uninstall         # both
ctx_plugin uninstall --rtk   # RTK only
ctx_plugin uninstall --caveman  # Caveman only
```

### `ctx_plugin doctor`

Check install status — shows which plugins are present and where.

```bash
ctx_plugin doctor
```

### `ctx_plugin gain`

RTK token savings report — reads from RTK's tracking database (`~/Library/Application Support/rtk/history.db`).

```bash
ctx_plugin gain              # all-time summary
ctx_plugin gain --today     # today's summary + category breakdown
ctx_plugin gain --since 7   # last 7 days
ctx_plugin gain --project myproj  # filter by project (last 90d)
ctx_plugin gain --share     # one-line summary
```

Output includes:
- Commands tracked, tokens saved, average savings rate
- Parse failures with failure rate
- Breakdown by command category (git, ls, grep, docker…)
- Daily trend chart
- Failure details

Colors: savings rate ≥80% green → <40% red.

## RTK Plugin

RTK rewrites bash commands before execution. When RTK can produce the same output locally, it does — saving the tokens that would otherwise go to the LLM.

See [opencode RTK plugin docs](https://docs.opencode.ai/plugins/rtk) for how it works.

## Caveman

Caveman skills teach opencode to prefer simple, portable shell commands over tool calls. Use it as a fallback layer for commands RTK doesn't rewrite.

See [caveman help](commands/caveman-help.md) for details.

## Files

```
ctx_plugin/
  bin/
    cli.js           # entry point (ctx_plugin)
    gain.js          # RTK gain report
    install.js       # shared install logic
    install-rtk.js   # RTK-specific install
    install-caveman.js  # Caveman-specific install
    uninstall.js    # shared uninstall logic
  src/
    index.ts        # main plugin exports
    rtk.ts          # RTK plugin helper
  skills/
    caveman-help/   # Caveman skill
  commands/
    caveman-help.md # command reference
  agents/
    caveman-agent/  # Caveman agent
```

## Requirements

- [opencode](https://github.com/opencode-ai/opencode)
- [RTK](https://github.com/rtk-ai/tinykt) (`brew install rtk-ai/tap/rtk`)
- Node.js ≥ 18 or Bun
