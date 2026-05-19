use crate::domain::{AiTool, CommandSpec, PlanStep, ScanReport, ToolId};

const RTK_PATHS: &[&str] = &[
    "~/.claude/settings.json",
    "~/.claude/hooks/",
    "~/.claude/RTK.md",
];

pub fn install_plan(scan: &ScanReport, ai_tools: &[AiTool]) -> Vec<PlanStep> {
    if scan.rtk_present {
        return vec![init_step("Configure RTK globally", ai_tools)];
    }

    let mut steps = Vec::new();

    if scan.cargo_available {
        steps.push(rtk_step(
            "Install RTK via cargo",
            CommandSpec::new(
                "cargo",
                ["install", "--git", "https://github.com/rtk-ai/rtk"],
            ),
        )
        .with_continue_on_failure());
    }
    if scan.brew_available {
        steps.push(rtk_step(
            "Install RTK via Homebrew",
            CommandSpec::new("brew", ["install", "rtk"]),
        )
        .with_continue_on_failure());
    }
    steps.push(
        rtk_step(
            "Install RTK via curl script",
            CommandSpec::new(
                "sh",
                [
                    "-c",
                    "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
                ],
            ),
        )
        .with_continue_on_failure(),
    );

    steps.push(init_step("Configure RTK globally", ai_tools));
    steps
}

pub fn uninstall_plan(scan: &ScanReport, ai_tools: &[AiTool]) -> Vec<PlanStep> {
    if !scan.rtk_present {
        return vec![];
    }

    let mut steps = vec![uninit_step("Unconfigure RTK hooks", ai_tools)];

    if scan.cargo_available {
        steps.push(
            rtk_step(
                "Remove RTK via cargo",
                CommandSpec::new("cargo", ["uninstall", "rtk"]),
            )
            .with_continue_on_failure(),
        );
    }
    if scan.brew_available {
        steps.push(
            rtk_step(
                "Remove RTK via Homebrew",
                CommandSpec::new("brew", ["uninstall", "rtk"]),
            )
            .with_continue_on_failure(),
        );
    }
    steps.push(
        rtk_step(
            "Remove RTK binary from ~/.local/bin",
            CommandSpec::new("rm", ["-f", "~/.local/bin/rtk"]),
        )
        .with_continue_on_failure(),
    );

    steps.push(
        shell_step(
            "Remove RTK configs",
            "rm -rf ~/.config/rtk/ ~/Library/Application\\ Support/rtk/ ~/.local/share/rtk/",
        )
        .with_continue_on_failure(),
    );

    steps
}

pub fn upgrade_plan(scan: &ScanReport, ai_tools: &[AiTool]) -> Vec<PlanStep> {
    let mut steps = Vec::new();

    if scan.cargo_available {
        steps.push(
            rtk_step(
                "Upgrade RTK via cargo",
                CommandSpec::new(
                    "cargo",
                    [
                        "install",
                        "--force",
                        "--git",
                        "https://github.com/rtk-ai/rtk",
                    ],
                ),
            )
            .with_continue_on_failure(),
        );
    }
    if scan.brew_available {
        steps.push(
            rtk_step(
                "Upgrade RTK via Homebrew",
                CommandSpec::new("brew", ["upgrade", "rtk"]),
            )
            .with_continue_on_failure(),
        );
    }
    steps.push(
        rtk_step(
            "Upgrade RTK via curl script",
            CommandSpec::new(
                "sh",
                [
                    "-c",
                    "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
                ],
            ),
        )
        .with_continue_on_failure(),
    );

    steps.push(init_step("Re-init RTK globally", ai_tools));
    steps
}

fn init_step(title: &str, ai_tools: &[AiTool]) -> PlanStep {
    let mut args = vec!["init".to_owned(), "-g".to_owned()];
    for tool in ai_tools {
        args.extend(tool.cli_flags());
    }
    rtk_step(title, CommandSpec::new("rtk", args))
}

fn uninit_step(title: &str, ai_tools: &[AiTool]) -> PlanStep {
    let mut args = vec!["init".to_owned(), "-g".to_owned(), "--uninstall".to_owned()];
    for tool in ai_tools {
        args.extend(tool.cli_flags());
    }
    rtk_step(title, CommandSpec::new("rtk", args))
}

fn rtk_step(title: &str, command: CommandSpec) -> PlanStep {
    PlanStep::new(ToolId::Rtk, title, command, rtk_paths())
}

fn shell_step(title: &str, script: &str) -> PlanStep {
    PlanStep::new(
        ToolId::Rtk,
        title,
        CommandSpec::new("sh", ["-c", script]),
        rtk_paths(),
    )
}

fn rtk_paths() -> Vec<String> {
    RTK_PATHS
        .iter()
        .map(|path| (*path).to_owned())
        .collect()
}
