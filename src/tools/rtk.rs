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
        let mut steps = vec![step(
            "Remove wrong RTK package",
            "cargo",
            ["uninstall", "rtk"],
        )];
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

    let mut steps = vec![
        install,
        step("Configure RTK globally", "rtk", ["init", "-g"]),
    ];
    steps.extend(verify_steps());
    steps
}

fn uninstall_steps() -> Vec<PlanStep> {
    vec![
        step(
            "Uninstall RTK global integration",
            "rtk",
            ["init", "-g", "--uninstall"],
        ),
        step("Remove RTK Homebrew package", "brew", ["uninstall", "rtk"]),
    ]
}

fn upgrade_steps(scan: &ScanReport) -> Vec<PlanStep> {
    let mut steps = if scan.brew_available {
        vec![step(
            "Upgrade RTK with Homebrew",
            "brew",
            ["upgrade", "rtk"],
        )]
    } else {
        vec![step(
            "Upgrade RTK with Cargo",
            "cargo",
            [
                "install",
                "--git",
                "https://github.com/rtk-ai/rtk",
                "--force",
            ],
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
