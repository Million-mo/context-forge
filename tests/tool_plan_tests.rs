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
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(
        commands,
        vec![
            "brew install rtk",
            "rtk init -g",
            "rtk gain",
            "rtk init --show"
        ]
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
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

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
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

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
    let commands: Vec<_> = plan
        .steps
        .iter()
        .map(|step| step.command.display())
        .collect();

    assert_eq!(
        commands,
        vec![
            "rtk init -g --uninstall",
            "brew uninstall rtk",
            "npx -y github:JuliusBrussee/caveman --uninstall"
        ]
    );
}
