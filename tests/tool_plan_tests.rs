use context_forge::domain::{Action, AiTool, ScanReport, ToolId, ToolSelection};
use context_forge::planner::build_plan;

#[test]
fn rtk_missing_with_cargo_generates_individual_install_steps() {
    let selection = ToolSelection {
        action: Action::Install,
        tool: ToolId::Rtk,
        ai_tools: vec![AiTool::Claude],
    };
    let scan = ScanReport::builder()
        .cargo_available(true)
        .rtk_present(false)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(commands.len(), 3); // cargo install, curl fallback, rtk init -g
    assert_eq!(
        commands[0],
        "cargo install --git https://github.com/rtk-ai/rtk"
    );
    assert!(commands[1].starts_with("sh -c curl"));
    assert_eq!(commands[2], "rtk init -g");
    // cargo and curl steps continue on failure
    assert!(plan.steps[0].continue_on_failure);
    assert!(plan.steps[1].continue_on_failure);
    assert!(!plan.steps[2].continue_on_failure); // init must succeed
}

#[test]
fn rtk_missing_without_cargo_falls_back_to_brew() {
    let selection = ToolSelection {
        action: Action::Install,
        tool: ToolId::Rtk,
        ai_tools: vec![AiTool::Claude],
    };
    let scan = ScanReport::builder()
        .brew_available(true)
        .rtk_present(false)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(commands.len(), 3); // brew, curl, init
    assert_eq!(commands[0], "brew install rtk");
    assert!(plan.steps[0].continue_on_failure);
}

#[test]
fn rtk_present_skips_install_only_configures() {
    let selection = ToolSelection {
        action: Action::Install,
        tool: ToolId::Rtk,
        ai_tools: vec![AiTool::Claude],
    };
    let scan = ScanReport::builder()
        .brew_available(true)
        .rtk_present(true)
        .rtk_gain_ok(true)
        .rtk_init_show_ok(true)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(commands, vec!["rtk init -g",]);
}

#[test]
fn caveman_missing_node_creates_verify_only_failure_hint_step() {
    let selection = ToolSelection {
        action: Action::Install,
        tool: ToolId::Caveman,
        ai_tools: vec![AiTool::Claude],
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
        action: Action::Install,
        tool: ToolId::Caveman,
        ai_tools: vec![AiTool::Claude],
    };
    let scan = ScanReport::builder()
        .node_major(Some(22))
        .npx_available(true)
        .caveman_local_repo(None)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(
        commands,
        vec![
            "npx -y github:JuliusBrussee/caveman --all",
            "npx -y github:JuliusBrussee/caveman --list"
        ]
    );
}

#[test]
fn rtk_missing_with_both_brew_and_cargo_tries_all_three() {
    let selection = ToolSelection {
        action: Action::Install,
        tool: ToolId::Rtk,
        ai_tools: vec![AiTool::Claude],
    };
    let scan = ScanReport::builder()
        .cargo_available(true)
        .brew_available(true)
        .rtk_present(false)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(commands.len(), 4); // cargo, brew, curl, init
    assert_eq!(
        commands[0],
        "cargo install --git https://github.com/rtk-ai/rtk"
    );
    assert_eq!(commands[1], "brew install rtk");
    assert!(commands[2].starts_with("sh -c curl"));
    assert_eq!(commands[3], "rtk init -g");
    // first 3 continue on failure
    assert!(plan.steps[0].continue_on_failure);
    assert!(plan.steps[1].continue_on_failure);
    assert!(plan.steps[2].continue_on_failure);
    assert!(!plan.steps[3].continue_on_failure);
}

#[test]
fn rtk_uninstall_uses_individual_steps() {
    let selection = ToolSelection {
        action: Action::Uninstall,
        tool: ToolId::Rtk,
        ai_tools: vec![],
    };
    let scan = ScanReport::builder()
        .cargo_available(true)
        .brew_available(true)
        .rtk_present(true)
        .build();

    let plan = build_plan(&selection, &scan);
    let titles: Vec<_> = plan.steps.iter().map(|step| step.title.as_str()).collect();

    assert_eq!(titles, vec![
        "Unconfigure RTK hooks",
        "Remove RTK via cargo",
        "Remove RTK via Homebrew",
        "Remove RTK binary from ~/.local/bin",
        "Remove RTK configs",
    ]);
    // unconfigure (index 0) must succeed; removal steps (1..) continue on failure
    assert!(!plan.steps[0].continue_on_failure);
    for step in &plan.steps[1..] {
        assert!(step.continue_on_failure);
    }
}

#[test]
fn rtk_uninstall_not_present_is_noop() {
    let selection = ToolSelection {
        action: Action::Uninstall,
        tool: ToolId::Rtk,
        ai_tools: vec![],
    };
    let scan = ScanReport::builder()
        .rtk_present(false)
        .build();

    let plan = build_plan(&selection, &scan);
    assert!(plan.steps.is_empty());
}

#[test]
fn rtk_upgrade_uses_individual_steps() {
    let selection = ToolSelection {
        action: Action::Upgrade,
        tool: ToolId::Rtk,
        ai_tools: vec![AiTool::Claude],
    };
    let scan = ScanReport::builder()
        .cargo_available(true)
        .brew_available(true)
        .rtk_present(true)
        .build();

    let plan = build_plan(&selection, &scan);
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(commands.len(), 4); // cargo upgrade, brew upgrade, curl, init
    assert_eq!(
        commands[0],
        "cargo install --force --git https://github.com/rtk-ai/rtk"
    );
    assert_eq!(commands[1], "brew upgrade rtk");
    assert!(commands[2].starts_with("sh -c curl"));
    assert_eq!(commands[3], "rtk init -g");
    // first 3 continue on failure
    assert!(plan.steps[0].continue_on_failure);
    assert!(plan.steps[1].continue_on_failure);
    assert!(plan.steps[2].continue_on_failure);
    assert!(!plan.steps[3].continue_on_failure);
}

#[test]
fn rtk_uninstall_with_ai_tools_includes_agent_flags() {
    let selection = ToolSelection {
        action: Action::Uninstall,
        tool: ToolId::Rtk,
        ai_tools: vec![AiTool::Cursor, AiTool::OpenCode],
    };
    let scan = ScanReport::builder()
        .cargo_available(true)
        .rtk_present(true)
        .build();

    let plan = build_plan(&selection, &scan);
    assert_eq!(
        plan.steps[0].command.display(),
        "rtk init -g --uninstall --agent cursor --opencode"
    );
}
