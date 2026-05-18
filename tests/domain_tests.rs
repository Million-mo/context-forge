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
