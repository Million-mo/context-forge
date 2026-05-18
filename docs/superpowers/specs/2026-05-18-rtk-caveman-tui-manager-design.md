# RTK + Caveman TUI Manager Design

Date: 2026-05-18

## Summary

Build a macOS-first Rust + Ratatui terminal UI for managing RTK and Caveman. The app is a fast-starting wizard with an ops-console feel: dense, precise, keyboard-first, and transparent about what it will do.

The first version supports install, uninstall, status management, upgrade, repair, verification, and a non-mutating preview mode called "预演模式" (`dry-run`). It uses each upstream project's recommended install and uninstall mechanisms rather than inventing separate installation paths.

## Goals

- Start quickly by showing tool selection before scanning the system.
- Manage RTK and Caveman through a guided TUI.
- Use each project's recommended install, uninstall, upgrade, and repair commands.
- Detect status after the user selects tools, then generate a recommended plan.
- Execute recommended flows by default after the plan summary.
- Provide a preview mode that shows commands and touched paths without changing the system.
- Stream logs, show failures clearly, and give retry, skip, preview, and back actions.
- Keep the architecture extensible enough to add more tools later.

## Non-Goals

- Windows and Linux parity in the first version.
- A plugin system for third-party tool definitions.
- A persistent global database of installed tools.
- Custom replacement installers for RTK or Caveman.
- Automatic destructive cleanup outside upstream uninstall commands.

## Product Decisions

- Project name: Context Forge.
- Binary name: `context-forge`.
- Platform: macOS first.
- Implementation: Rust + Ratatui single binary.
- UI style: Ops Console.
- Tool architecture: configuration-style built-in tool definitions.
- Default execution behavior: execute the recommended plan after the user confirms the plan summary.
- Preview wording: use "预演模式" in the UI, with `dry-run` as the technical term where useful.
- Log directory: `~/Library/Application Support/context-forge/logs/`.
- Local repository mode: developer-only flag in v1, not the default user path.
- Caveman agent UI scope: first-class controls for Claude Code, Codex, opencode, and OpenClaw; other supported agents are shown through Caveman's installer list/details.

## User Flow

1. Fast launch
   - The app opens directly to tool selection.
   - It loads built-in RTK and Caveman definitions only.
   - It does not run environment scans at startup.

2. Tool selection
   - RTK and Caveman are selected by default.
   - The user can choose tools and high-level actions.
   - Available actions are install, uninstall, upgrade, repair, verify, and recommended.

3. On-demand scan
   - After the user confirms the selected tools, the app scans only the relevant environment.
   - RTK scans check `rtk`, Homebrew, Cargo, Claude configuration, and RTK identity.
   - Caveman scans check Node, npx, local or remote installer availability, supported agents, and relevant config paths.

4. Plan generation
   - The app turns scan results into a recommended execution plan.
   - Typical recommendations:
     - Not installed: install and configure.
     - Installed and healthy: verify or skip.
     - Installed with broken config: repair.
     - Older version: upgrade.

5. Plan summary
   - The summary shows tools, steps, commands, and likely touched paths.
   - `Enter` executes the plan.
   - `D` switches to 预演模式.
   - `E` expands command details.
   - `Esc` returns to tool selection.

6. Execution and verification
   - The UI shows a step list and a real-time log panel.
   - Each step streams stdout and stderr.
   - Each tool runs verification after its action.

7. Results
   - The final page shows success, failure, skipped items, next steps, and the session log path.

## Architecture

The app has four main layers.

### TUI App

The Ratatui frontend owns:

- Wizard routing.
- Keyboard navigation.
- Tool selection.
- Plan summary.
- Step progress.
- Log display.
- Failure dialogs.
- Result summary.

It does not directly encode installer logic. It renders state produced by the application core.

### Tool Definitions

Each tool definition describes a lifecycle:

- Detect.
- Install.
- Configure, when separate from install.
- Uninstall.
- Upgrade.
- Repair.
- Verify.
- Touched paths.
- Recovery hints.

RTK and Caveman are built in as Rust definitions for the first version. The shape should remain data-oriented enough that a future external definition format is possible, but that is not required for v1.

### Execution Engine

The execution engine:

- Converts selected tools and scan results into a plan.
- Supports normal execution and 预演模式.
- Runs commands step by step.
- Streams output into the UI.
- Captures exit codes.
- Marks each step as pending, running, succeeded, skipped, or failed.
- Stops on failure and offers retry, skip, preview, and back actions.

The engine should use an injectable command runner so tests can simulate commands without changing the host system.

### State Store

State is primarily in memory and derived from current scans. A session log may be written under the platform-appropriate app data directory. There is no persistent source of truth beyond upstream tool state and configuration files.

## RTK Definition

### Detection

- Check `which rtk`.
- Run `rtk --version` when present.
- Run `rtk gain` to confirm this is Rust Token Killer, not the unrelated Rust Type Kit project.
- Check `rtk init --show` when available.
- Detect Homebrew and Cargo availability.

### Install

Use upstream recommended macOS options:

- Prefer `brew install rtk` when Homebrew is available.
- If Homebrew is unavailable, offer the official `install.sh` route or Cargo route as alternatives.

### Configure

- Run `rtk init -g`.

### Uninstall

- First run `rtk init -g --uninstall` to remove global RTK hook/config integration.
- Then remove the binary according to detected or selected install source:
  - `brew uninstall rtk`.
  - `cargo uninstall rtk`.
  - Manual removal for script-installed binary paths.

For local project setup, show that local `CLAUDE.md` changes must be reviewed manually because upstream docs call this out separately.

### Upgrade

- Use `brew upgrade rtk` for Homebrew installs.
- For Cargo or script installs, use the upstream recommended reinstall/update route.

### Repair

- Re-run `rtk init -g`.
- Validate with `rtk init --show` and `rtk gain`.

### Verify

- `rtk gain`.
- `rtk init --show`.

## Caveman Definition

### Detection

- Check Node.js exists and is version 18 or newer.
- Check `npx`.
- Check local installer availability when using the local repository.
- Detect supported agents through Caveman's own installer list and agent checks where possible.
- Inspect relevant config paths for Claude Code, Codex, opencode, OpenClaw, and other supported agents when shown by the installer.

### Install

Use Caveman's unified installer:

- Remote mode: official `install.sh` or `npx -y github:JuliusBrussee/caveman`.
- Local developer mode: `node bin/install.js` from a checked-out Caveman repository.

Default recommended scope is equivalent to `--all`, with UI controls for narrower `--only <agent>` selections.

### Uninstall

- Run Caveman's `--uninstall`.
- Show that upstream uninstall does not remove skills installed through the skills CLI or per-repo rule files written by `--with-init`.

### Upgrade

- Re-run the installer.
- Use `--force` when repair or explicit upgrade requires reapplying existing installs.

### Repair

- Re-run the installer for the selected scope, usually `--all --force` or `--only <agent> --force`.

### Verify

- Run `node bin/install.js --list` in local repo mode.
- Check Caveman flag/config paths where relevant.
- Show agent-specific verification hints such as trying `/caveman`.

## Preview Mode

Preview mode is shown as "预演模式" in the TUI.

It must not mutate system state. It shows:

- Commands that would run.
- Paths that may be touched.
- Expected verification commands.
- Risks and manual cleanup notes.

Where upstream installers support their own dry-run, use that. Where they do not, the app previews the generated plan without executing commands.

## Error Handling

Each step has one of these states:

- Pending.
- Running.
- Succeeded.
- Skipped.
- Failed.

On failure, the TUI stays open on the failed step and shows:

- The command.
- Exit code.
- Concise stdout and stderr.
- Suggested recovery action.

Available actions:

- Retry.
- Switch to 预演模式.
- Skip the step.
- Go back and change selections.
- Quit after writing the session log.

The app does not run automatic destructive cleanup after failures. Cleanup follows upstream uninstall or documented repair commands.

## Logging

The execution engine records under `~/Library/Application Support/context-forge/logs/`:

- Timestamp.
- Tool.
- Action.
- Command.
- Exit code.
- stdout and stderr snippets.
- Full output path when output is long.

The result page includes the session log path.

## Testing Strategy

### Unit Tests

- Tool definitions produce correct plans from scan results.
- RTK identity detection rejects an `rtk` binary where `rtk gain` is unavailable.
- Caveman detection handles missing Node, old Node, and missing npx.
- Preview mode generates commands without invoking the command runner.

### Execution Engine Tests

- Success path.
- Command failure.
- Skipped step.
- Retry path.
- Log capture.
- Verification failure after install success.

### TUI State Tests

- Tool selection toggles.
- Action selection.
- Shortcut behavior for `Enter`, `D`, `E`, and `Esc`.
- Route transitions from selection to scan to plan to execution to result.

### Integration Tests

Use a fake command runner and fake filesystem/config fixtures for:

- Homebrew present and RTK missing.
- Wrong RTK installed.
- RTK installed but hook missing.
- Node missing for Caveman.
- Caveman partial install.
- Uninstall with cleanup notes.

No integration test should modify the real developer system by default.
