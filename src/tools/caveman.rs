use crate::domain::{AiTool, CommandSpec, PlanStep, ScanReport, ToolId};

/// Paths caveman touches during install (for display / plan summary).
/// These are specific sub-paths, never whole config directories.
const CAVEMAN_PATHS: &[&str] = &[
    "~/.claude/settings.json",
    "~/.claude/hooks/",
    "~/.claude/.caveman-active",
    "~/.config/opencode/plugins/caveman/",
    "~/.config/opencode/commands/caveman*.md",
    "~/.config/opencode/agents/cavecrew-*.md",
    "~/.config/opencode/skills/caveman*/",
    "~/.config/opencode/opencode.json",
    "~/.openclaw/workspace/skills/caveman/",
    "~/.openclaw/workspace/SOUL.md",
];

pub fn install_plan(scan: &ScanReport) -> Vec<PlanStep> {
    if !node_ready(scan) {
        return vec![step("Check Node.js requirement", "node", ["--version"])];
    }

    vec![
        installer_step("Install Caveman", scan, ["--all"]),
        list_step(scan),
    ]
}

pub fn uninstall_plan(scan: &ScanReport, _ai_tools: &[AiTool]) -> Vec<PlanStep> {
    if !node_ready(scan) {
        return vec![step("Check Node.js requirement", "node", ["--version"])];
    }

    // caveman --uninstall is manifest-driven: it only removes what it
    // installed (individual hook files, plugin dirs, manifest-matched
    // commands/agents/skills, marker-fenced blocks). It never deletes
    // parent directories like ~/.config/opencode/ or ~/.openclaw/.
    vec![installer_step("Uninstall Caveman (surgical)", scan, ["--uninstall"])]
}

pub fn upgrade_plan(scan: &ScanReport) -> Vec<PlanStep> {
    if !node_ready(scan) {
        return vec![step("Check Node.js requirement", "node", ["--version"])];
    }

    vec![
        installer_step("Upgrade Caveman", scan, ["--all"]),
        list_step(scan),
    ]
}

fn node_ready(scan: &ScanReport) -> bool {
    scan.node_major.is_some_and(|major| major >= 18) && scan.npx_available
}

fn installer_step<const N: usize>(title: &str, _scan: &ScanReport, args: [&str; N]) -> PlanStep {
    let mut command_args = vec!["-y".to_owned(), "github:JuliusBrussee/caveman".to_owned()];
    command_args.extend(args.iter().map(|arg| (*arg).to_owned()));

    PlanStep::new(
        ToolId::Caveman,
        title,
        CommandSpec::new("npx", command_args),
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
    CAVEMAN_PATHS
        .iter()
        .map(|path| (*path).to_owned())
        .collect()
}
