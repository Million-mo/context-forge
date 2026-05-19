use context_forge::domain::{CommandSpec, Plan, PlanStep, StepState, ToolId, ToolSelection};

#[test]
fn default_tool_selection_selects_rtk() {
    let selection = ToolSelection::default();

    assert_eq!(selection.tool, ToolId::Rtk);
    assert_eq!(selection.action, context_forge::domain::Action::Install);
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
            vec![
                "~/.claude/settings.json".into(),
                "~/.config/opencode/".into(),
            ],
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

#[test]
fn plan_step_continue_on_failure_defaults_to_false() {
    let step = PlanStep::new(
        ToolId::Rtk,
        "test",
        CommandSpec::new("echo", ["hello"]),
        vec![],
    );
    assert!(!step.continue_on_failure);
}

#[test]
fn plan_step_with_continue_on_failure_sets_flag() {
    let step = PlanStep::new(
        ToolId::Rtk,
        "test",
        CommandSpec::new("echo", ["hello"]),
        vec![],
    )
    .with_continue_on_failure();
    assert!(step.continue_on_failure);
}
