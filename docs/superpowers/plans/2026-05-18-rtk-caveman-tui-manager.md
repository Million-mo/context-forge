# RTK + Caveman TUI Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first macOS-focused `context-forge` Rust/Ratatui TUI for installing, uninstalling, upgrading, repairing, verifying, and previewing RTK and Caveman flows.

**Architecture:** Implement the non-UI core first: domain types, tool definitions, scan-to-plan logic, command runner abstraction, execution engine, and logging. Then add a TUI state machine and Ratatui shell that render the tested core without embedding installer logic in UI code.

**Tech Stack:** Rust 2021, Ratatui, Crossterm, Tokio, Serde, directories, time, tempfile, assert_cmd.

---

## File Structure

- `Cargo.toml` defines the binary crate, dependencies, and test dependencies.
- `src/main.rs` starts the terminal UI and reports fatal startup errors.
- `src/lib.rs` exposes the app modules for integration tests.
- `src/domain.rs` owns shared enums and structs: tools, actions, commands, scans, plans, step states, and execution results.
- `src/runner.rs` defines `CommandRunner`, `RealCommandRunner`, and `FakeCommandRunner` for tests.
- `src/tools/mod.rs` exports built-in tool definitions.
- `src/tools/rtk.rs` defines RTK scan interpretation and plan generation.
- `src/tools/caveman.rs` defines Caveman scan interpretation and plan generation.
- `src/planner.rs` coordinates selected tools, scan results, and plan creation.
- `src/executor.rs` runs plans in normal mode or preview mode.
- `src/logging.rs` writes session logs under `~/Library/Application Support/context-forge/logs/`.
- `src/tui/mod.rs` exports TUI modules.
- `src/tui/state.rs` owns page routing, selections, shortcuts, and execution view state.
- `src/tui/render.rs` renders Ratatui widgets from `tui::state`.
- `src/tui/terminal.rs` owns Crossterm setup and the event loop.
- `tests/domain_tests.rs` checks domain defaults and state transitions.
- `tests/tool_plan_tests.rs` checks RTK/Caveman scan-to-plan behavior.
- `tests/executor_tests.rs` checks preview, success, failure, retry, and verification behavior.
- `tests/tui_state_tests.rs` checks keyboard-driven wizard transitions.

---

### Task 1: Rust Scaffold And Domain Model

**Files:**
- Create: `Cargo.toml`
- Create: `src/lib.rs`
- Create: `src/main.rs`
- Create: `src/domain.rs`
- Test: `tests/domain_tests.rs`

- [ ] **Step 1: Write failing domain tests**

Create `tests/domain_tests.rs`:

```rust
use context_forge::domain::{
    Action, CommandSpec, ExecutionMode, Plan, PlanStep, StepState, ToolId, ToolSelection,
};

#[test]
fn default_tool_selection_selects_rtk_and_caveman_with_recommended_action() {
    let selection = ToolSelection::default();

    assert_eq!(selection.mode, ExecutionMode::Apply);
    assert_eq!(selection.tools, vec![ToolId::Rtk, ToolId::Caveman]);
    assert_eq!(selection.action, Action::Recommended);
}

#[test]
fn command_spec_formats_shell_like_command() {
    let command = CommandSpec::new("rtk", ["init", "-g"]);

    assert_eq!(command.program, "rtk");
    assert_eq!(command.args, vec!["init", "-g"]);
    assert_eq!(command.display(), "rtk init -g");
}

#[test]
fn plan_reports_touched_paths_from_all_steps_without_duplicates() {
    let plan = Plan::new(vec![
        PlanStep::new(
            ToolId::Rtk,
            "Configure RTK",
            CommandSpec::new("rtk", ["init", "-g"]),
            vec!["~/.claude/settings.json".into(), "~/.claude/hooks/".into()],
        ),
        PlanStep::new(
            ToolId::Caveman,
            "Install Caveman",
            CommandSpec::new("node", ["bin/install.js", "--all"]),
            vec!["~/.claude/settings.json".into(), "~/.config/opencode/".into()],
        ),
    ]);

    assert_eq!(
        plan.touched_paths(),
        vec![
            "~/.claude/settings.json",
            "~/.claude/hooks/",
            "~/.config/opencode/",
        ]
    );
}

#[test]
fn step_state_knows_when_execution_should_stop() {
    assert!(!StepState::Pending.is_terminal());
    assert!(!StepState::Running.is_terminal());
    assert!(StepState::Succeeded.is_terminal());
    assert!(StepState::Skipped.is_terminal());
    assert!(StepState::Failed { code: Some(2) }.is_terminal());
}
```

- [ ] **Step 2: Run domain tests and verify they fail**

Run:

```bash
cargo test --test domain_tests
```

Expected: FAIL because the crate and domain types do not exist yet.

- [ ] **Step 3: Add Cargo scaffold**

Create `Cargo.toml`:

```toml
[package]
name = "context-forge"
version = "0.1.0"
edition = "2021"
description = "macOS-first TUI manager for RTK and Caveman"
license = "MIT"

[[bin]]
name = "context-forge"
path = "src/main.rs"

[dependencies]
anyhow = "1"
directories = "5"
ratatui = "0.29"
crossterm = "0.28"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
time = { version = "0.3", features = ["formatting", "macros"] }
tokio = { version = "1", features = ["macros", "process", "rt-multi-thread", "sync", "time"] }

[dev-dependencies]
assert_cmd = "2"
tempfile = "3"
```

Create `src/lib.rs`:

```rust
pub mod domain;
```

Create `src/main.rs`:

```rust
fn main() {
    if let Err(error) = run() {
        eprintln!("context-forge: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    println!("context-forge TUI coming online");
    Ok(())
}
```

- [ ] **Step 4: Add domain implementation**

Create `src/domain.rs`:

```rust
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ToolId {
    Rtk,
    Caveman,
}

impl ToolId {
    pub fn label(self) -> &'static str {
        match self {
            ToolId::Rtk => "RTK",
            ToolId::Caveman => "Caveman",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Recommended,
    Install,
    Uninstall,
    Upgrade,
    Repair,
    Verify,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionMode {
    Apply,
    Preview,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolSelection {
    pub tools: Vec<ToolId>,
    pub action: Action,
    pub mode: ExecutionMode,
}

impl Default for ToolSelection {
    fn default() -> Self {
        Self {
            tools: vec![ToolId::Rtk, ToolId::Caveman],
            action: Action::Recommended,
            mode: ExecutionMode::Apply,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    pub fn new<I, S>(program: impl Into<String>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    pub fn display(&self) -> String {
        if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanStep {
    pub tool: ToolId,
    pub title: String,
    pub command: CommandSpec,
    pub touched_paths: Vec<String>,
    pub state: StepState,
}

impl PlanStep {
    pub fn new(
        tool: ToolId,
        title: impl Into<String>,
        command: CommandSpec,
        touched_paths: Vec<String>,
    ) -> Self {
        Self {
            tool,
            title: title.into(),
            command,
            touched_paths,
            state: StepState::Pending,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
}

impl Plan {
    pub fn new(steps: Vec<PlanStep>) -> Self {
        Self { steps }
    }

    pub fn touched_paths(&self) -> Vec<&str> {
        let mut seen = BTreeSet::new();
        let mut ordered = Vec::new();

        for path in self.steps.iter().flat_map(|step| step.touched_paths.iter()) {
            if seen.insert(path.as_str()) {
                ordered.push(path.as_str());
            }
        }

        ordered
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StepState {
    Pending,
    Running,
    Succeeded,
    Skipped,
    Failed { code: Option<i32> },
}

impl StepState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            StepState::Succeeded | StepState::Skipped | StepState::Failed { .. }
        )
    }
}
```

- [ ] **Step 5: Run domain tests and verify they pass**

Run:

```bash
cargo test --test domain_tests
```

Expected: PASS for 4 tests.

- [ ] **Step 6: Commit scaffold**

```bash
git add Cargo.toml src/lib.rs src/main.rs src/domain.rs tests/domain_tests.rs
git commit -m "feat: scaffold Rust domain model"
```

---

### Task 2: Tool Scans And Plan Generation

**Files:**
- Modify: `src/lib.rs`
- Modify: `src/domain.rs`
- Create: `src/tools/mod.rs`
- Create: `src/tools/rtk.rs`
- Create: `src/tools/caveman.rs`
- Create: `src/planner.rs`
- Test: `tests/tool_plan_tests.rs`

- [ ] **Step 1: Write failing tool plan tests**

Create `tests/tool_plan_tests.rs`:

```rust
use context_forge::domain::{Action, ExecutionMode, ScanReport, ToolId, ToolSelection};
use context_forge::planner::build_plan;

#[test]
fn rtk_missing_with_brew_generates_brew_install_configure_and_verify() {
    let selection = ToolSelection {
        tools: vec![ToolId::Rtk],
        action: Action::Recommended,
        mode: ExecutionMode::Apply,
    };
    let scan = ScanReport::builder()
        .brew_available(true)
        .rtk_present(false)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan.steps.iter().map(|step| step.command.display()).collect();

    assert_eq!(
        commands,
        vec!["brew install rtk", "rtk init -g", "rtk gain", "rtk init --show"]
    );
}

#[test]
fn wrong_rtk_identity_generates_cargo_uninstall_before_install() {
    let selection = ToolSelection {
        tools: vec![ToolId::Rtk],
        action: Action::Recommended,
        mode: ExecutionMode::Apply,
    };
    let scan = ScanReport::builder()
        .brew_available(true)
        .rtk_present(true)
        .rtk_gain_ok(false)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan.steps.iter().map(|step| step.command.display()).collect();

    assert_eq!(
        commands,
        vec![
            "cargo uninstall rtk",
            "brew install rtk",
            "rtk init -g",
            "rtk gain",
            "rtk init --show"
        ]
    );
}

#[test]
fn rtk_broken_config_generates_repair_plan() {
    let selection = ToolSelection {
        tools: vec![ToolId::Rtk],
        action: Action::Recommended,
        mode: ExecutionMode::Apply,
    };
    let scan = ScanReport::builder()
        .rtk_present(true)
        .rtk_gain_ok(true)
        .rtk_init_show_ok(false)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan.steps.iter().map(|step| step.command.display()).collect();

    assert_eq!(commands, vec!["rtk init -g", "rtk gain", "rtk init --show"]);
}

#[test]
fn caveman_missing_node_creates_verify_only_failure_hint_step() {
    let selection = ToolSelection {
        tools: vec![ToolId::Caveman],
        action: Action::Recommended,
        mode: ExecutionMode::Apply,
    };
    let scan = ScanReport::builder()
        .node_major(None)
        .npx_available(false)
        .build();

    let plan = build_plan(&selection, &scan);

    assert_eq!(plan.steps.len(), 1);
    assert_eq!(plan.steps[0].title, "Check Node.js requirement");
    assert_eq!(plan.steps[0].command.display(), "node --version");
}

#[test]
fn caveman_with_node_generates_all_install_and_list_verification() {
    let selection = ToolSelection {
        tools: vec![ToolId::Caveman],
        action: Action::Install,
        mode: ExecutionMode::Apply,
    };
    let scan = ScanReport::builder()
        .node_major(Some(22))
        .npx_available(true)
        .caveman_local_repo(None)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan.steps.iter().map(|step| step.command.display()).collect();

    assert_eq!(
        commands,
        vec![
            "npx -y github:JuliusBrussee/caveman --all",
            "npx -y github:JuliusBrussee/caveman --list"
        ]
    );
}

#[test]
fn uninstall_selected_tools_uses_upstream_uninstall_commands() {
    let selection = ToolSelection {
        tools: vec![ToolId::Rtk, ToolId::Caveman],
        action: Action::Uninstall,
        mode: ExecutionMode::Apply,
    };
    let scan = ScanReport::builder()
        .rtk_present(true)
        .rtk_gain_ok(true)
        .node_major(Some(22))
        .npx_available(true)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan.steps.iter().map(|step| step.command.display()).collect();

    assert_eq!(
        commands,
        vec![
            "rtk init -g --uninstall",
            "brew uninstall rtk",
            "npx -y github:JuliusBrussee/caveman --uninstall"
        ]
    );
}
```

- [ ] **Step 2: Run tool plan tests and verify they fail**

Run:

```bash
cargo test --test tool_plan_tests
```

Expected: FAIL with unresolved imports for `ScanReport`, `planner`, and tool modules.

- [ ] **Step 3: Extend domain with scan report builder**

Append this to `src/domain.rs`:

```rust
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ScanReport {
    pub brew_available: bool,
    pub cargo_available: bool,
    pub rtk_present: bool,
    pub rtk_gain_ok: bool,
    pub rtk_init_show_ok: bool,
    pub node_major: Option<u32>,
    pub npx_available: bool,
    pub caveman_local_repo: Option<String>,
}

impl ScanReport {
    pub fn builder() -> ScanReportBuilder {
        ScanReportBuilder::default()
    }
}

#[derive(Clone, Debug, Default)]
pub struct ScanReportBuilder {
    report: ScanReport,
}

impl ScanReportBuilder {
    pub fn brew_available(mut self, value: bool) -> Self {
        self.report.brew_available = value;
        self
    }

    pub fn cargo_available(mut self, value: bool) -> Self {
        self.report.cargo_available = value;
        self
    }

    pub fn rtk_present(mut self, value: bool) -> Self {
        self.report.rtk_present = value;
        self
    }

    pub fn rtk_gain_ok(mut self, value: bool) -> Self {
        self.report.rtk_gain_ok = value;
        self
    }

    pub fn rtk_init_show_ok(mut self, value: bool) -> Self {
        self.report.rtk_init_show_ok = value;
        self
    }

    pub fn node_major(mut self, value: Option<u32>) -> Self {
        self.report.node_major = value;
        self
    }

    pub fn npx_available(mut self, value: bool) -> Self {
        self.report.npx_available = value;
        self
    }

    pub fn caveman_local_repo(mut self, value: Option<&str>) -> Self {
        self.report.caveman_local_repo = value.map(str::to_owned);
        self
    }

    pub fn build(self) -> ScanReport {
        self.report
    }
}
```

- [ ] **Step 4: Add tool modules**

Modify `src/lib.rs`:

```rust
pub mod domain;
pub mod planner;
pub mod tools;
```

Create `src/tools/mod.rs`:

```rust
pub mod caveman;
pub mod rtk;
```

Create `src/tools/rtk.rs`:

```rust
use crate::domain::{Action, CommandSpec, PlanStep, ScanReport, ToolId};

const RTK_PATHS: &[&str] = &[
    "~/.claude/settings.json",
    "~/.claude/hooks/",
    "~/.claude/RTK.md",
    "~/.claude/CLAUDE.md",
];

pub fn plan(action: Action, scan: &ScanReport) -> Vec<PlanStep> {
    match action {
        Action::Uninstall => uninstall_steps(),
        Action::Upgrade => upgrade_steps(scan),
        Action::Repair => repair_steps(),
        Action::Verify => verify_steps(),
        Action::Install => install_steps(scan),
        Action::Recommended => recommended_steps(scan),
    }
}

fn recommended_steps(scan: &ScanReport) -> Vec<PlanStep> {
    if scan.rtk_present && !scan.rtk_gain_ok {
        let mut steps = vec![step("Remove wrong RTK package", "cargo", ["uninstall", "rtk"])];
        steps.extend(install_steps(scan));
        return steps;
    }

    if !scan.rtk_present {
        return install_steps(scan);
    }

    if !scan.rtk_init_show_ok {
        return repair_steps();
    }

    verify_steps()
}

fn install_steps(scan: &ScanReport) -> Vec<PlanStep> {
    let install = if scan.brew_available {
        step("Install RTK with Homebrew", "brew", ["install", "rtk"])
    } else {
        step(
            "Install RTK with Cargo",
            "cargo",
            ["install", "--git", "https://github.com/rtk-ai/rtk"],
        )
    };

    let mut steps = vec![install, step("Configure RTK globally", "rtk", ["init", "-g"])];
    steps.extend(verify_steps());
    steps
}

fn uninstall_steps() -> Vec<PlanStep> {
    vec![
        step("Uninstall RTK global integration", "rtk", ["init", "-g", "--uninstall"]),
        step("Remove RTK Homebrew package", "brew", ["uninstall", "rtk"]),
    ]
}

fn upgrade_steps(scan: &ScanReport) -> Vec<PlanStep> {
    let mut steps = if scan.brew_available {
        vec![step("Upgrade RTK with Homebrew", "brew", ["upgrade", "rtk"])]
    } else {
        vec![step(
            "Upgrade RTK with Cargo",
            "cargo",
            ["install", "--git", "https://github.com/rtk-ai/rtk", "--force"],
        )]
    };
    steps.extend(repair_steps());
    steps
}

fn repair_steps() -> Vec<PlanStep> {
    let mut steps = vec![step("Repair RTK global integration", "rtk", ["init", "-g"])];
    steps.extend(verify_steps());
    steps
}

fn verify_steps() -> Vec<PlanStep> {
    vec![
        step("Verify RTK identity", "rtk", ["gain"]),
        step("Verify RTK hook status", "rtk", ["init", "--show"]),
    ]
}

fn step<const N: usize>(title: &str, program: &str, args: [&str; N]) -> PlanStep {
    PlanStep::new(
        ToolId::Rtk,
        title,
        CommandSpec::new(program, args),
        RTK_PATHS.iter().map(|path| (*path).to_owned()).collect(),
    )
}
```

Create `src/tools/caveman.rs`:

```rust
use crate::domain::{Action, CommandSpec, PlanStep, ScanReport, ToolId};

const CAVEMAN_PATHS: &[&str] = &[
    "~/.claude/settings.json",
    "~/.claude/hooks/",
    "~/.claude/.caveman-active",
    "~/.config/opencode/",
    "~/.openclaw/workspace/",
];

pub fn plan(action: Action, scan: &ScanReport) -> Vec<PlanStep> {
    if !node_ready(scan) {
        return vec![step("Check Node.js requirement", "node", ["--version"])];
    }

    match action {
        Action::Uninstall => vec![installer_step("Uninstall Caveman", scan, ["--uninstall"])],
        Action::Upgrade => vec![
            installer_step("Upgrade Caveman", scan, ["--all", "--force"]),
            list_step(scan),
        ],
        Action::Repair => vec![
            installer_step("Repair Caveman", scan, ["--all", "--force"]),
            list_step(scan),
        ],
        Action::Verify => vec![list_step(scan)],
        Action::Install | Action::Recommended => {
            vec![installer_step("Install Caveman", scan, ["--all"]), list_step(scan)]
        }
    }
}

fn node_ready(scan: &ScanReport) -> bool {
    scan.node_major.is_some_and(|major| major >= 18) && scan.npx_available
}

fn installer_step<const N: usize>(title: &str, scan: &ScanReport, args: [&str; N]) -> PlanStep {
    if scan.caveman_local_repo.is_some() {
        let mut command_args = vec!["bin/install.js".to_owned()];
        command_args.extend(args.iter().map(|arg| (*arg).to_owned()));
        return PlanStep::new(
            ToolId::Caveman,
            title,
            CommandSpec::new("node", command_args),
            touched_paths(),
        );
    }

    PlanStep::new(
        ToolId::Caveman,
        title,
        CommandSpec::new(
            "npx",
            std::iter::once("-y")
                .chain(std::iter::once("github:JuliusBrussee/caveman"))
                .chain(args)
                .collect::<Vec<_>>(),
        ),
        touched_paths(),
    )
}

fn list_step(scan: &ScanReport) -> PlanStep {
    installer_step("List Caveman install targets", scan, ["--list"])
}

fn step<const N: usize>(title: &str, program: &str, args: [&str; N]) -> PlanStep {
    PlanStep::new(
        ToolId::Caveman,
        title,
        CommandSpec::new(program, args),
        touched_paths(),
    )
}

fn touched_paths() -> Vec<String> {
    CAVEMAN_PATHS.iter().map(|path| (*path).to_owned()).collect()
}
```

- [ ] **Step 5: Add planner**

Create `src/planner.rs`:

```rust
use crate::domain::{Plan, ScanReport, ToolId, ToolSelection};
use crate::tools::{caveman, rtk};

pub fn build_plan(selection: &ToolSelection, scan: &ScanReport) -> Plan {
    let mut steps = Vec::new();

    for tool in &selection.tools {
        match tool {
            ToolId::Rtk => steps.extend(rtk::plan(selection.action, scan)),
            ToolId::Caveman => steps.extend(caveman::plan(selection.action, scan)),
        }
    }

    Plan::new(steps)
}
```

- [ ] **Step 6: Run tool plan tests and verify they pass**

Run:

```bash
cargo test --test tool_plan_tests
```

Expected: PASS for 6 tests.

- [ ] **Step 7: Run all tests**

Run:

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 8: Commit tool planning**

```bash
git add src/lib.rs src/domain.rs src/tools src/planner.rs tests/tool_plan_tests.rs
git commit -m "feat: add RTK and Caveman plan generation"
```

---

### Task 3: Command Runner And On-Demand Scanner

**Files:**
- Modify: `src/lib.rs`
- Create: `src/runner.rs`
- Create: `src/scanner.rs`
- Test: `tests/scanner_tests.rs`

- [ ] **Step 1: Write failing scanner tests**

Create `tests/scanner_tests.rs`:

```rust
use context_forge::domain::ToolId;
use context_forge::runner::{FakeCommandRunner, Output};
use context_forge::scanner::scan_selected_tools;

#[tokio::test]
async fn scan_rtk_detects_correct_identity_and_brew() {
    let runner = FakeCommandRunner::new()
        .with_success("which", ["rtk"], "/Users/me/.local/bin/rtk\n")
        .with_success("rtk", ["gain"], "saved 1200 tokens\n")
        .with_success("rtk", ["init", "--show"], "Hook: installed\n")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n");

    let scan = scan_selected_tools(&runner, &[ToolId::Rtk]).await;

    assert!(scan.rtk_present);
    assert!(scan.rtk_gain_ok);
    assert!(scan.rtk_init_show_ok);
    assert!(scan.brew_available);
}

#[tokio::test]
async fn scan_rtk_marks_wrong_identity_when_gain_fails() {
    let runner = FakeCommandRunner::new()
        .with_success("which", ["rtk"], "/Users/me/.cargo/bin/rtk\n")
        .with_failure("rtk", ["gain"], 2, "unknown command gain\n");

    let scan = scan_selected_tools(&runner, &[ToolId::Rtk]).await;

    assert!(scan.rtk_present);
    assert!(!scan.rtk_gain_ok);
}

#[tokio::test]
async fn scan_caveman_extracts_node_major_version_and_npx() {
    let runner = FakeCommandRunner::new()
        .with_success("node", ["--version"], "v22.16.0\n")
        .with_success("which", ["npx"], "/opt/homebrew/bin/npx\n");

    let scan = scan_selected_tools(&runner, &[ToolId::Caveman]).await;

    assert_eq!(scan.node_major, Some(22));
    assert!(scan.npx_available);
}

#[tokio::test]
async fn scan_caveman_handles_missing_node() {
    let runner = FakeCommandRunner::new()
        .with_output("node", ["--version"], Output::failure(127, "node not found\n"))
        .with_failure("which", ["npx"], 1, "");

    let scan = scan_selected_tools(&runner, &[ToolId::Caveman]).await;

    assert_eq!(scan.node_major, None);
    assert!(!scan.npx_available);
}
```

- [ ] **Step 2: Run scanner tests and verify they fail**

Run:

```bash
cargo test --test scanner_tests
```

Expected: FAIL with unresolved imports for `runner` and `scanner`.

- [ ] **Step 3: Add command runner abstraction**

Modify `src/lib.rs`:

```rust
pub mod domain;
pub mod planner;
pub mod runner;
pub mod scanner;
pub mod tools;
```

Create `src/runner.rs`:

```rust
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;

use crate::domain::CommandSpec;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    pub fn failure(code: i32, stderr: impl Into<String>) -> Self {
        Self {
            code,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }

    pub fn succeeded(&self) -> bool {
        self.code == 0
    }
}

pub type RunnerFuture<'a> = Pin<Box<dyn Future<Output = Output> + Send + 'a>>;

pub trait CommandRunner: Send + Sync {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a>;
}

#[derive(Default)]
pub struct RealCommandRunner;

impl CommandRunner for RealCommandRunner {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a> {
        Box::pin(async move {
            match tokio::process::Command::new(&command.program)
                .args(&command.args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await
            {
                Ok(output) => Output {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                },
                Err(error) => Output {
                    code: 127,
                    stdout: String::new(),
                    stderr: error.to_string(),
                },
            }
        })
    }
}

#[derive(Clone, Default)]
pub struct FakeCommandRunner {
    outputs: HashMap<String, Output>,
}

impl FakeCommandRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_success<const N: usize>(
        mut self,
        program: &str,
        args: [&str; N],
        stdout: &str,
    ) -> Self {
        self.outputs.insert(key(program, args), Output::success(stdout));
        self
    }

    pub fn with_failure<const N: usize>(
        mut self,
        program: &str,
        args: [&str; N],
        code: i32,
        stderr: &str,
    ) -> Self {
        self.outputs
            .insert(key(program, args), Output::failure(code, stderr));
        self
    }

    pub fn with_output<const N: usize>(
        mut self,
        program: &str,
        args: [&str; N],
        output: Output,
    ) -> Self {
        self.outputs.insert(key(program, args), output);
        self
    }
}

impl CommandRunner for FakeCommandRunner {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a> {
        Box::pin(async move {
            self.outputs
                .get(&command.display())
                .cloned()
                .unwrap_or_else(|| Output::failure(127, format!("no fake output for {}", command.display())))
        })
    }
}

fn key<const N: usize>(program: &str, args: [&str; N]) -> String {
    CommandSpec::new(program, args).display()
}
```

- [ ] **Step 4: Add scanner**

Create `src/scanner.rs`:

```rust
use crate::domain::{CommandSpec, ScanReport, ToolId};
use crate::runner::CommandRunner;

pub async fn scan_selected_tools(runner: &dyn CommandRunner, tools: &[ToolId]) -> ScanReport {
    let mut builder = ScanReport::builder();

    if tools.contains(&ToolId::Rtk) {
        let rtk_present = run_ok(runner, CommandSpec::new("which", ["rtk"])).await;
        let rtk_gain_ok = rtk_present && run_ok(runner, CommandSpec::new("rtk", ["gain"])).await;
        let rtk_init_show_ok =
            rtk_present && run_ok(runner, CommandSpec::new("rtk", ["init", "--show"])).await;
        let brew_available = run_ok(runner, CommandSpec::new("which", ["brew"])).await;
        let cargo_available = run_ok(runner, CommandSpec::new("which", ["cargo"])).await;

        builder = builder
            .rtk_present(rtk_present)
            .rtk_gain_ok(rtk_gain_ok)
            .rtk_init_show_ok(rtk_init_show_ok)
            .brew_available(brew_available)
            .cargo_available(cargo_available);
    }

    if tools.contains(&ToolId::Caveman) {
        let node_output = runner.run(&CommandSpec::new("node", ["--version"])).await;
        let node_major = if node_output.succeeded() {
            parse_node_major(&node_output.stdout)
        } else {
            None
        };
        let npx_available = run_ok(runner, CommandSpec::new("which", ["npx"])).await;

        builder = builder.node_major(node_major).npx_available(npx_available);
    }

    builder.build()
}

async fn run_ok(runner: &dyn CommandRunner, command: CommandSpec) -> bool {
    runner.run(&command).await.succeeded()
}

fn parse_node_major(stdout: &str) -> Option<u32> {
    stdout
        .trim()
        .strip_prefix('v')
        .unwrap_or_else(|| stdout.trim())
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
}
```

- [ ] **Step 5: Run scanner tests and verify they pass**

Run:

```bash
cargo test --test scanner_tests
```

Expected: PASS for 4 tests.

- [ ] **Step 6: Run all tests**

Run:

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 7: Commit scanner**

```bash
git add src/lib.rs src/runner.rs src/scanner.rs tests/scanner_tests.rs
git commit -m "feat: add on-demand environment scanner"
```

---

### Task 4: Execution Engine And Preview Mode

**Files:**
- Modify: `src/lib.rs`
- Create: `src/executor.rs`
- Test: `tests/executor_tests.rs`

- [ ] **Step 1: Write failing executor tests**

Create `tests/executor_tests.rs`:

```rust
use context_forge::domain::{CommandSpec, ExecutionMode, Plan, PlanStep, StepState, ToolId};
use context_forge::executor::execute_plan;
use context_forge::runner::FakeCommandRunner;

fn sample_plan() -> Plan {
    Plan::new(vec![
        PlanStep::new(
            ToolId::Rtk,
            "Configure RTK",
            CommandSpec::new("rtk", ["init", "-g"]),
            vec!["~/.claude/settings.json".into()],
        ),
        PlanStep::new(
            ToolId::Rtk,
            "Verify RTK",
            CommandSpec::new("rtk", ["gain"]),
            vec![],
        ),
    ])
}

#[tokio::test]
async fn preview_mode_does_not_run_commands_and_marks_steps_skipped() {
    let runner = FakeCommandRunner::new();
    let result = execute_plan(sample_plan(), ExecutionMode::Preview, &runner).await;

    assert!(result.success);
    assert_eq!(result.outputs.len(), 0);
    assert_eq!(result.steps[0].state, StepState::Skipped);
    assert_eq!(result.steps[1].state, StepState::Skipped);
}

#[tokio::test]
async fn apply_mode_runs_all_steps_until_success() {
    let runner = FakeCommandRunner::new()
        .with_success("rtk", ["init", "-g"], "configured\n")
        .with_success("rtk", ["gain"], "saved tokens\n");

    let result = execute_plan(sample_plan(), ExecutionMode::Apply, &runner).await;

    assert!(result.success);
    assert_eq!(result.outputs.len(), 2);
    assert_eq!(result.steps[0].state, StepState::Succeeded);
    assert_eq!(result.steps[1].state, StepState::Succeeded);
}

#[tokio::test]
async fn apply_mode_stops_on_first_failed_step() {
    let runner = FakeCommandRunner::new()
        .with_failure("rtk", ["init", "-g"], 2, "permission denied\n")
        .with_success("rtk", ["gain"], "should not run\n");

    let result = execute_plan(sample_plan(), ExecutionMode::Apply, &runner).await;

    assert!(!result.success);
    assert_eq!(result.outputs.len(), 1);
    assert_eq!(result.steps[0].state, StepState::Failed { code: Some(2) });
    assert_eq!(result.steps[1].state, StepState::Pending);
    assert!(result.failure_summary().contains("permission denied"));
}
```

- [ ] **Step 2: Run executor tests and verify they fail**

Run:

```bash
cargo test --test executor_tests
```

Expected: FAIL with unresolved import for `executor`.

- [ ] **Step 3: Add execution result types**

Modify `src/domain.rs` by appending:

```rust
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepOutput {
    pub command: String,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionResult {
    pub success: bool,
    pub steps: Vec<PlanStep>,
    pub outputs: Vec<StepOutput>,
}

impl ExecutionResult {
    pub fn failure_summary(&self) -> String {
        self.outputs
            .iter()
            .rev()
            .find(|output| output.code != 0)
            .map(|output| {
                if output.stderr.trim().is_empty() {
                    output.stdout.trim().to_owned()
                } else {
                    output.stderr.trim().to_owned()
                }
            })
            .unwrap_or_default()
    }
}
```

- [ ] **Step 4: Add executor**

Modify `src/lib.rs`:

```rust
pub mod domain;
pub mod executor;
pub mod planner;
pub mod runner;
pub mod scanner;
pub mod tools;
```

Create `src/executor.rs`:

```rust
use crate::domain::{
    ExecutionMode, ExecutionResult, Plan, StepOutput, StepState,
};
use crate::runner::CommandRunner;

pub async fn execute_plan(
    mut plan: Plan,
    mode: ExecutionMode,
    runner: &dyn CommandRunner,
) -> ExecutionResult {
    if mode == ExecutionMode::Preview {
        for step in &mut plan.steps {
            step.state = StepState::Skipped;
        }
        return ExecutionResult {
            success: true,
            steps: plan.steps,
            outputs: Vec::new(),
        };
    }

    let mut outputs = Vec::new();
    let mut success = true;

    for step in &mut plan.steps {
        step.state = StepState::Running;
        let output = runner.run(&step.command).await;
        outputs.push(StepOutput {
            command: step.command.display(),
            code: output.code,
            stdout: output.stdout.clone(),
            stderr: output.stderr.clone(),
        });

        if output.succeeded() {
            step.state = StepState::Succeeded;
        } else {
            step.state = StepState::Failed {
                code: Some(output.code),
            };
            success = false;
            break;
        }
    }

    ExecutionResult {
        success,
        steps: plan.steps,
        outputs,
    }
}
```

- [ ] **Step 5: Run executor tests and verify they pass**

Run:

```bash
cargo test --test executor_tests
```

Expected: PASS for 3 tests.

- [ ] **Step 6: Run all tests**

Run:

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 7: Commit executor**

```bash
git add src/lib.rs src/domain.rs src/executor.rs tests/executor_tests.rs
git commit -m "feat: add plan execution engine"
```

---

### Task 5: Session Logging

**Files:**
- Modify: `src/lib.rs`
- Create: `src/logging.rs`
- Test: `tests/logging_tests.rs`

- [ ] **Step 1: Write failing logging tests**

Create `tests/logging_tests.rs`:

```rust
use context_forge::domain::{ExecutionResult, PlanStep, StepOutput, StepState, ToolId, CommandSpec};
use context_forge::logging::{default_log_dir, write_session_log};

#[test]
fn default_log_dir_uses_macos_application_support_path() {
    let path = default_log_dir().expect("log directory should resolve");
    let text = path.to_string_lossy();

    assert!(text.contains("Application Support"));
    assert!(text.ends_with("context-forge/logs"));
}

#[test]
fn write_session_log_records_commands_and_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let result = ExecutionResult {
        success: false,
        steps: vec![PlanStep {
            tool: ToolId::Rtk,
            title: "Configure RTK".into(),
            command: CommandSpec::new("rtk", ["init", "-g"]),
            touched_paths: vec!["~/.claude/settings.json".into()],
            state: StepState::Failed { code: Some(2) },
        }],
        outputs: vec![StepOutput {
            command: "rtk init -g".into(),
            code: 2,
            stdout: String::new(),
            stderr: "permission denied".into(),
        }],
    };

    let path = write_session_log(dir.path(), &result).unwrap();
    let contents = std::fs::read_to_string(path).unwrap();

    assert!(contents.contains("success: false"));
    assert!(contents.contains("command: rtk init -g"));
    assert!(contents.contains("stderr: permission denied"));
}
```

- [ ] **Step 2: Run logging tests and verify they fail**

Run:

```bash
cargo test --test logging_tests
```

Expected: FAIL with unresolved import for `logging`.

- [ ] **Step 3: Add logging module**

Modify `src/lib.rs`:

```rust
pub mod domain;
pub mod executor;
pub mod logging;
pub mod planner;
pub mod runner;
pub mod scanner;
pub mod tools;
```

Create `src/logging.rs`:

```rust
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::domain::ExecutionResult;

pub fn default_log_dir() -> Option<PathBuf> {
    ProjectDirs::from("", "", "context-forge")
        .map(|dirs| dirs.data_dir().join("logs"))
}

pub fn write_session_log(dir: &Path, result: &ExecutionResult) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let timestamp = OffsetDateTime::now_utc()
        .format(format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_else(|_| "session".to_owned());
    let path = dir.join(format!("{timestamp}.log"));

    let mut contents = String::new();
    contents.push_str(&format!("success: {}\n", result.success));
    contents.push_str("\nsteps:\n");
    for step in &result.steps {
        contents.push_str(&format!(
            "- tool: {}\n  title: {}\n  command: {}\n  state: {:?}\n",
            step.tool.label(),
            step.title,
            step.command.display(),
            step.state
        ));
    }
    contents.push_str("\noutputs:\n");
    for output in &result.outputs {
        contents.push_str(&format!(
            "- command: {}\n  code: {}\n  stdout: {}\n  stderr: {}\n",
            output.command,
            output.code,
            output.stdout.trim(),
            output.stderr.trim()
        ));
    }

    fs::write(&path, contents)?;
    Ok(path)
}
```

- [ ] **Step 4: Run logging tests and verify they pass**

Run:

```bash
cargo test --test logging_tests
```

Expected: PASS for 2 tests.

- [ ] **Step 5: Run all tests**

Run:

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 6: Commit logging**

```bash
git add src/lib.rs src/logging.rs tests/logging_tests.rs
git commit -m "feat: add session logging"
```

---

### Task 6: TUI State Machine

**Files:**
- Modify: `src/lib.rs`
- Create: `src/tui/mod.rs`
- Create: `src/tui/state.rs`
- Test: `tests/tui_state_tests.rs`

- [ ] **Step 1: Write failing TUI state tests**

Create `tests/tui_state_tests.rs`:

```rust
use context_forge::domain::{Action, ExecutionMode, ToolId};
use context_forge::tui::state::{AppPage, AppState, KeyCommand};

#[test]
fn app_starts_fast_on_tool_selection_without_scan() {
    let app = AppState::new();

    assert_eq!(app.page, AppPage::ToolSelection);
    assert_eq!(app.selection.tools, vec![ToolId::Rtk, ToolId::Caveman]);
    assert!(!app.scan_started);
}

#[test]
fn pressing_enter_on_tool_selection_moves_to_scanning() {
    let mut app = AppState::new();

    app.handle(KeyCommand::Enter);

    assert_eq!(app.page, AppPage::Scanning);
    assert!(app.scan_started);
}

#[test]
fn pressing_d_on_plan_summary_toggles_preview_mode() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    app.handle(KeyCommand::Preview);

    assert_eq!(app.selection.mode, ExecutionMode::Preview);
}

#[test]
fn pressing_escape_from_plan_summary_returns_to_tool_selection() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    app.handle(KeyCommand::Back);

    assert_eq!(app.page, AppPage::ToolSelection);
}

#[test]
fn action_cycle_moves_from_recommended_to_install() {
    let mut app = AppState::new();

    app.handle(KeyCommand::NextAction);

    assert_eq!(app.selection.action, Action::Install);
}
```

- [ ] **Step 2: Run TUI state tests and verify they fail**

Run:

```bash
cargo test --test tui_state_tests
```

Expected: FAIL with unresolved import for `tui::state`.

- [ ] **Step 3: Add TUI state module**

Modify `src/lib.rs`:

```rust
pub mod domain;
pub mod executor;
pub mod logging;
pub mod planner;
pub mod runner;
pub mod scanner;
pub mod tools;
pub mod tui;
```

Create `src/tui/mod.rs`:

```rust
pub mod state;
```

Create `src/tui/state.rs`:

```rust
use crate::domain::{Action, ExecutionMode, ToolSelection};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPage {
    ToolSelection,
    Scanning,
    PlanSummary,
    Executing,
    Results,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyCommand {
    Enter,
    Preview,
    Expand,
    Back,
    NextAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppState {
    pub page: AppPage,
    pub selection: ToolSelection,
    pub scan_started: bool,
    pub details_expanded: bool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            page: AppPage::ToolSelection,
            selection: ToolSelection::default(),
            scan_started: false,
            details_expanded: false,
        }
    }

    pub fn handle(&mut self, command: KeyCommand) {
        match (self.page, command) {
            (AppPage::ToolSelection, KeyCommand::Enter) => {
                self.page = AppPage::Scanning;
                self.scan_started = true;
            }
            (AppPage::PlanSummary, KeyCommand::Preview) => {
                self.selection.mode = ExecutionMode::Preview;
            }
            (AppPage::PlanSummary, KeyCommand::Expand) => {
                self.details_expanded = !self.details_expanded;
            }
            (AppPage::PlanSummary, KeyCommand::Back) => {
                self.page = AppPage::ToolSelection;
            }
            (_, KeyCommand::NextAction) => {
                self.selection.action = next_action(self.selection.action);
            }
            _ => {}
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn next_action(action: Action) -> Action {
    match action {
        Action::Recommended => Action::Install,
        Action::Install => Action::Uninstall,
        Action::Uninstall => Action::Upgrade,
        Action::Upgrade => Action::Repair,
        Action::Repair => Action::Verify,
        Action::Verify => Action::Recommended,
    }
}
```

- [ ] **Step 4: Run TUI state tests and verify they pass**

Run:

```bash
cargo test --test tui_state_tests
```

Expected: PASS for 5 tests.

- [ ] **Step 5: Run all tests**

Run:

```bash
cargo test
```

Expected: all tests pass.

- [ ] **Step 6: Commit TUI state**

```bash
git add src/lib.rs src/tui tests/tui_state_tests.rs
git commit -m "feat: add TUI state machine"
```

---

### Task 7: Ratatui Rendering Shell

**Files:**
- Modify: `src/tui/mod.rs`
- Create: `src/tui/render.rs`
- Create: `src/tui/terminal.rs`
- Modify: `src/main.rs`
- Test: `tests/render_tests.rs`

- [ ] **Step 1: Write failing render tests**

Create `tests/render_tests.rs`:

```rust
use context_forge::tui::render::render_to_text_for_test;
use context_forge::tui::state::{AppPage, AppState};

#[test]
fn tool_selection_render_contains_ops_console_title_and_tools() {
    let app = AppState::new();
    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Context Forge"));
    assert!(text.contains("RTK"));
    assert!(text.contains("Caveman"));
    assert!(text.contains("Enter"));
}

#[test]
fn plan_summary_render_mentions_preview_shortcut() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Plan Summary"));
    assert!(text.contains("D"));
    assert!(text.contains("预演模式"));
}
```

- [ ] **Step 2: Run render tests and verify they fail**

Run:

```bash
cargo test --test render_tests
```

Expected: FAIL with unresolved import for `tui::render`.

- [ ] **Step 3: Add render module**

Modify `src/tui/mod.rs`:

```rust
pub mod render;
pub mod state;
pub mod terminal;
```

Create `src/tui/render.rs`:

```rust
use ratatui::backend::TestBackend;
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::domain::ToolId;
use crate::tui::state::{AppPage, AppState};

pub fn render(frame: &mut Frame<'_>, app: &AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(3),
        ])
        .split(frame.area());

    let header = Paragraph::new(Line::from(vec![
        Span::styled("Context Forge", Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw("  RTK + Caveman Manager"),
    ]))
    .block(Block::default().borders(Borders::ALL));
    frame.render_widget(header, chunks[0]);

    match app.page {
        AppPage::ToolSelection => render_tool_selection(frame, app, chunks[1]),
        AppPage::Scanning => render_message(frame, "Scanning selected tools...", chunks[1]),
        AppPage::PlanSummary => render_message(frame, "Plan Summary\nD 预演模式    E expand commands    Enter execute    Esc back", chunks[1]),
        AppPage::Executing => render_message(frame, "Executing plan...", chunks[1]),
        AppPage::Results => render_message(frame, "Results", chunks[1]),
    }

    let footer = Paragraph::new("Enter continue   D 预演模式   E details   Esc back")
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(footer, chunks[2]);
}

fn render_tool_selection(frame: &mut Frame<'_>, app: &AppState, area: ratatui::layout::Rect) {
    let items: Vec<ListItem> = [ToolId::Rtk, ToolId::Caveman]
        .into_iter()
        .map(|tool| {
            let selected = app.selection.tools.contains(&tool);
            let marker = if selected { "[x]" } else { "[ ]" };
            ListItem::new(format!("{marker} {}", tool.label()))
        })
        .collect();

    let list = List::new(items).block(
        Block::default()
            .title("Choose tools")
            .borders(Borders::ALL),
    );
    frame.render_widget(list, area);
}

fn render_message(frame: &mut Frame<'_>, message: &str, area: ratatui::layout::Rect) {
    frame.render_widget(
        Paragraph::new(message).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

pub fn render_to_text_for_test(app: &AppState, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = ratatui::Terminal::new(backend).expect("test terminal");
    terminal.draw(|frame| render(frame, app)).expect("draw frame");
    format!("{:?}", terminal.backend().buffer())
}
```

- [ ] **Step 4: Add terminal shell and wire main**

Create `src/tui/terminal.rs`:

```rust
use std::io;

use crossterm::event::{self, Event, KeyCode};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::tui::render::render;
use crate::tui::state::{AppState, KeyCommand};

pub fn run_terminal_app() -> anyhow::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = run_loop(&mut terminal);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

fn run_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>) -> anyhow::Result<()> {
    let mut app = AppState::new();

    loop {
        terminal.draw(|frame| render(frame, &app))?;

        if let Event::Key(key) = event::read()? {
            match key.code {
                KeyCode::Char('q') => break,
                KeyCode::Enter => app.handle(KeyCommand::Enter),
                KeyCode::Char('d') | KeyCode::Char('D') => app.handle(KeyCommand::Preview),
                KeyCode::Char('e') | KeyCode::Char('E') => app.handle(KeyCommand::Expand),
                KeyCode::Esc => app.handle(KeyCommand::Back),
                KeyCode::Tab => app.handle(KeyCommand::NextAction),
                _ => {}
            }
        }
    }

    Ok(())
}
```

Modify `src/main.rs`:

```rust
fn main() {
    if let Err(error) = context_forge::tui::terminal::run_terminal_app() {
        eprintln!("context-forge: {error:#}");
        std::process::exit(1);
    }
}
```

- [ ] **Step 5: Run render tests and verify they pass**

Run:

```bash
cargo test --test render_tests
```

Expected: PASS for 2 tests.

- [ ] **Step 6: Run all tests and build**

Run:

```bash
cargo test
cargo build
```

Expected: all tests pass and the binary builds.

- [ ] **Step 7: Commit rendering shell**

```bash
git add src/tui src/main.rs tests/render_tests.rs
git commit -m "feat: add Ratatui rendering shell"
```

---

### Task 8: Connect Wizard Flow To Scanner, Planner, Executor, And Logs

**Files:**
- Modify: `src/tui/state.rs`
- Modify: `src/tui/terminal.rs`
- Modify: `src/tui/render.rs`
- Test: `tests/tui_flow_tests.rs`

- [ ] **Step 1: Write failing flow tests**

Create `tests/tui_flow_tests.rs`:

```rust
use context_forge::domain::{ExecutionMode, StepState, ToolId};
use context_forge::runner::FakeCommandRunner;
use context_forge::tui::state::{AppPage, AppState};

#[tokio::test]
async fn start_scan_builds_plan_after_tool_selection() {
    let runner = FakeCommandRunner::new()
        .with_failure("which", ["rtk"], 1, "")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n")
        .with_success("which", ["cargo"], "/Users/me/.cargo/bin/cargo\n")
        .with_success("node", ["--version"], "v22.16.0\n")
        .with_success("which", ["npx"], "/opt/homebrew/bin/npx\n");
    let mut app = AppState::new();

    app.scan_and_plan(&runner).await;

    assert_eq!(app.page, AppPage::PlanSummary);
    assert!(app.plan.as_ref().unwrap().steps.iter().any(|step| step.tool == ToolId::Rtk));
    assert!(app.plan.as_ref().unwrap().steps.iter().any(|step| step.tool == ToolId::Caveman));
}

#[tokio::test]
async fn execute_preview_marks_steps_skipped_and_goes_to_results() {
    let runner = FakeCommandRunner::new()
        .with_failure("which", ["rtk"], 1, "")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n")
        .with_success("which", ["cargo"], "/Users/me/.cargo/bin/cargo\n");
    let mut app = AppState::new();
    app.selection.tools = vec![ToolId::Rtk];
    app.selection.mode = ExecutionMode::Preview;
    app.scan_and_plan(&runner).await;

    app.execute_current_plan(&runner).await;

    assert_eq!(app.page, AppPage::Results);
    assert!(app.execution_result.as_ref().unwrap().success);
    assert_eq!(
        app.execution_result.as_ref().unwrap().steps[0].state,
        StepState::Skipped
    );
}
```

- [ ] **Step 2: Run flow tests and verify they fail**

Run:

```bash
cargo test --test tui_flow_tests
```

Expected: FAIL because `AppState` does not store plans or execution results.

- [ ] **Step 3: Extend AppState**

Replace `src/tui/state.rs` with:

```rust
use crate::domain::{Action, ExecutionMode, ExecutionResult, Plan, ScanReport, ToolSelection};
use crate::executor::execute_plan;
use crate::planner::build_plan;
use crate::runner::CommandRunner;
use crate::scanner::scan_selected_tools;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPage {
    ToolSelection,
    Scanning,
    PlanSummary,
    Executing,
    Results,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyCommand {
    Enter,
    Preview,
    Expand,
    Back,
    NextAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppState {
    pub page: AppPage,
    pub selection: ToolSelection,
    pub scan_started: bool,
    pub details_expanded: bool,
    pub scan: Option<ScanReport>,
    pub plan: Option<Plan>,
    pub execution_result: Option<ExecutionResult>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            page: AppPage::ToolSelection,
            selection: ToolSelection::default(),
            scan_started: false,
            details_expanded: false,
            scan: None,
            plan: None,
            execution_result: None,
        }
    }

    pub fn handle(&mut self, command: KeyCommand) {
        match (self.page, command) {
            (AppPage::ToolSelection, KeyCommand::Enter) => {
                self.page = AppPage::Scanning;
                self.scan_started = true;
            }
            (AppPage::PlanSummary, KeyCommand::Enter) => {
                self.page = AppPage::Executing;
            }
            (AppPage::PlanSummary, KeyCommand::Preview) => {
                self.selection.mode = ExecutionMode::Preview;
            }
            (AppPage::PlanSummary, KeyCommand::Expand) => {
                self.details_expanded = !self.details_expanded;
            }
            (AppPage::PlanSummary, KeyCommand::Back) => {
                self.page = AppPage::ToolSelection;
            }
            (_, KeyCommand::NextAction) => {
                self.selection.action = next_action(self.selection.action);
            }
            _ => {}
        }
    }

    pub async fn scan_and_plan(&mut self, runner: &dyn CommandRunner) {
        self.page = AppPage::Scanning;
        self.scan_started = true;
        let scan = scan_selected_tools(runner, &self.selection.tools).await;
        let plan = build_plan(&self.selection, &scan);
        self.scan = Some(scan);
        self.plan = Some(plan);
        self.page = AppPage::PlanSummary;
    }

    pub async fn execute_current_plan(&mut self, runner: &dyn CommandRunner) {
        self.page = AppPage::Executing;
        if let Some(plan) = self.plan.clone() {
            let result = execute_plan(plan, self.selection.mode, runner).await;
            self.execution_result = Some(result);
        }
        self.page = AppPage::Results;
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn next_action(action: Action) -> Action {
    match action {
        Action::Recommended => Action::Install,
        Action::Install => Action::Uninstall,
        Action::Uninstall => Action::Upgrade,
        Action::Upgrade => Action::Repair,
        Action::Repair => Action::Verify,
        Action::Verify => Action::Recommended,
    }
}
```

- [ ] **Step 4: Update terminal loop to run scan and execution**

Replace the `KeyCode::Enter` arm in `src/tui/terminal.rs` with this block:

```rust
KeyCode::Enter => {
    match app.page {
        AppPage::ToolSelection => {
            app.scan_and_plan(&crate::runner::RealCommandRunner).await;
        }
        AppPage::PlanSummary => {
            app.execute_current_plan(&crate::runner::RealCommandRunner).await;
        }
        _ => app.handle(KeyCommand::Enter),
    }
}
```

Then update `run_loop` to be async and call it from `run_terminal_app` with a runtime:

```rust
pub fn run_terminal_app() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = runtime.block_on(run_loop(&mut terminal));

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>) -> anyhow::Result<()> {
    let mut app = AppState::new();
    loop {
        terminal.draw(|frame| render(frame, &app))?;
        if let Event::Key(key) = event::read()? {
            match key.code {
                KeyCode::Char('q') => break,
                KeyCode::Enter => {
                    match app.page {
                        AppPage::ToolSelection => {
                            app.scan_and_plan(&crate::runner::RealCommandRunner).await;
                        }
                        AppPage::PlanSummary => {
                            app.execute_current_plan(&crate::runner::RealCommandRunner).await;
                        }
                        _ => app.handle(KeyCommand::Enter),
                    }
                }
                KeyCode::Char('d') | KeyCode::Char('D') => app.handle(KeyCommand::Preview),
                KeyCode::Char('e') | KeyCode::Char('E') => app.handle(KeyCommand::Expand),
                KeyCode::Esc => app.handle(KeyCommand::Back),
                KeyCode::Tab => app.handle(KeyCommand::NextAction),
                _ => {}
            }
        }
    }
    Ok(())
}
```

Ensure `src/tui/terminal.rs` imports `AppPage`:

```rust
use crate::tui::state::{AppPage, AppState, KeyCommand};
```

- [ ] **Step 5: Update renderer with real plan and result panels**

In `src/tui/render.rs`, replace the `AppPage::PlanSummary`, `AppPage::Executing`, and `AppPage::Results` match arms with:

```rust
AppPage::PlanSummary => render_plan_summary(frame, app, chunks[1]),
AppPage::Executing => render_message(frame, "Executing plan...", chunks[1]),
AppPage::Results => render_results(frame, app, chunks[1]),
```

Add these functions to the same file:

```rust
fn render_plan_summary(frame: &mut Frame<'_>, app: &AppState, area: ratatui::layout::Rect) {
    let mut lines = vec![Line::from("Plan Summary")];
    if let Some(plan) = &app.plan {
        for step in &plan.steps {
            lines.push(Line::from(format!(
                "{}: {} -> {}",
                step.tool.label(),
                step.title,
                step.command.display()
            )));
        }
        lines.push(Line::from(format!(
            "Touched paths: {}",
            plan.touched_paths().join(", ")
        )));
    } else {
        lines.push(Line::from("No plan built yet"));
    }
    lines.push(Line::from("D 预演模式    E details    Enter execute    Esc back"));

    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

fn render_results(frame: &mut Frame<'_>, app: &AppState, area: ratatui::layout::Rect) {
    let mut lines = vec![Line::from("Results")];
    if let Some(result) = &app.execution_result {
        lines.push(Line::from(format!("success: {}", result.success)));
        for step in &result.steps {
            lines.push(Line::from(format!(
                "{}: {:?} {}",
                step.tool.label(),
                step.state,
                step.command.display()
            )));
        }
    } else {
        lines.push(Line::from("No execution result"));
    }

    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL)),
        area,
    );
}
```

- [ ] **Step 6: Run flow tests and verify they pass**

Run:

```bash
cargo test --test tui_flow_tests
```

Expected: PASS for 2 tests.

- [ ] **Step 7: Run all tests and build**

Run:

```bash
cargo test
cargo build
```

Expected: all tests pass and the binary builds.

- [ ] **Step 8: Commit wired flow**

```bash
git add src/tui tests/tui_flow_tests.rs
git commit -m "feat: connect TUI wizard to core engine"
```

---

### Task 9: CLI Smoke Surface And Documentation

**Files:**
- Modify: `src/main.rs`
- Create: `README.md`
- Test: `tests/cli_tests.rs`

- [ ] **Step 1: Write failing CLI tests**

Create `tests/cli_tests.rs`:

```rust
use assert_cmd::Command;

#[test]
fn help_mentions_preview_and_supported_tools() {
    let mut cmd = Command::cargo_bin("context-forge").unwrap();

    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicates::str::contains("RTK"))
        .stdout(predicates::str::contains("Caveman"))
        .stdout(predicates::str::contains("预演模式"));
}
```

- [ ] **Step 2: Add test dependency and verify failure**

Add to `Cargo.toml` under `[dev-dependencies]`:

```toml
predicates = "3"
```

Run:

```bash
cargo test --test cli_tests
```

Expected: FAIL because `--help` is not implemented.

- [ ] **Step 3: Add minimal CLI help**

Replace `src/main.rs` with:

```rust
fn main() {
    if std::env::args().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return;
    }

    if let Err(error) = context_forge::tui::terminal::run_terminal_app() {
        eprintln!("context-forge: {error:#}");
        std::process::exit(1);
    }
}

fn print_help() {
    println!(
        "context-forge\n\n\
         macOS-first TUI manager for RTK and Caveman.\n\n\
         Supported tools:\n\
           - RTK\n\
           - Caveman\n\n\
         Shortcuts:\n\
           Enter  continue or execute\n\
           D      预演模式 / dry-run\n\
           E      expand command details\n\
           Esc    back\n\
           q      quit\n"
    );
}
```

- [ ] **Step 4: Add README**

Create `README.md`:

```markdown
# Context Forge

Context Forge is a macOS-first terminal UI for managing RTK and Caveman.

It starts fast, lets you choose tools first, scans only the selected environment, then builds a recommended install, uninstall, upgrade, repair, or verify plan.

## First Version

- Rust + Ratatui single binary.
- RTK and Caveman built-in.
- Ops Console TUI style.
- Install, uninstall, upgrade, repair, verify.
- `D` switches to 预演模式 (`dry-run`) before execution.

## Run

```bash
cargo run
```

## Test

```bash
cargo test
```
```

- [ ] **Step 5: Run CLI tests and all tests**

Run:

```bash
cargo test --test cli_tests
cargo test
```

Expected: all tests pass.

- [ ] **Step 6: Commit smoke surface**

```bash
git add Cargo.toml src/main.rs README.md tests/cli_tests.rs
git commit -m "docs: add Context Forge smoke surface"
```

---

### Task 10: Manual Verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run formatting**

Run:

```bash
cargo fmt --check
```

Expected: PASS. If it fails, run `cargo fmt`, then repeat `cargo fmt --check`.

- [ ] **Step 2: Run all tests**

Run:

```bash
cargo test
```

Expected: PASS.

- [ ] **Step 3: Build debug binary**

Run:

```bash
cargo build
```

Expected: PASS and creates `target/debug/context-forge`.

- [ ] **Step 4: Launch TUI manually**

Run:

```bash
cargo run
```

Expected:

- TUI opens on the tool selection screen.
- RTK and Caveman are visible.
- Pressing `q` exits and restores the terminal.

- [ ] **Step 5: Commit formatting fixes if needed**

If `cargo fmt` changed files:

```bash
git add .
git commit -m "style: format Context Forge"
```

If `cargo fmt --check` passed without changes, skip this commit.

---

## Self-Review

- Spec coverage: the plan covers fast launch, macOS-first Rust/Ratatui, RTK/Caveman definitions, status scanning after tool selection, plan summary, default execution, preview mode, execution state, logging, testing, and docs.
- Scope: Linux and Windows parity, external plugins, and real destructive integration tests remain outside v1 as specified.
- Type consistency: `ToolId`, `Action`, `ExecutionMode`, `ScanReport`, `Plan`, `PlanStep`, `CommandSpec`, `StepState`, `ExecutionResult`, `CommandRunner`, `AppState`, and `AppPage` are introduced before use in later tasks.
- Testing order: each implementation task begins with a failing test and verifies the red-green loop before commit.
