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
            vec![
                installer_step("Install Caveman", scan, ["--all"]),
                list_step(scan),
            ]
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
