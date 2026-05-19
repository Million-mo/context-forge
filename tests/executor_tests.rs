use context_forge::domain::{CommandSpec, Plan, PlanStep, StepState, ToolId};
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
async fn apply_mode_runs_all_steps_until_success() {
    let runner = FakeCommandRunner::new()
        .with_success("rtk", ["init", "-g"], "configured\n")
        .with_success("rtk", ["gain"], "saved tokens\n");

    let result = execute_plan(sample_plan(), &runner).await;

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

    let result = execute_plan(sample_plan(), &runner).await;

    assert!(!result.success);
    assert_eq!(result.outputs.len(), 1);
    assert_eq!(result.steps[0].state, StepState::Failed { code: Some(2) });
    assert_eq!(result.steps[1].state, StepState::Pending);
    assert!(result.failure_summary().contains("permission denied"));
}

#[tokio::test]
async fn continue_on_failure_does_not_stop_execution() {
    let runner = FakeCommandRunner::new()
        .with_failure("rtk", ["init", "-g"], 2, "first fail\n")
        .with_success("rtk", ["gain"], "second ok\n");

    let plan = Plan::new(vec![
        PlanStep::new(
            ToolId::Rtk,
            "Step that can fail",
            CommandSpec::new("rtk", ["init", "-g"]),
            vec![],
        )
        .with_continue_on_failure(),
        PlanStep::new(
            ToolId::Rtk,
            "Step that must succeed",
            CommandSpec::new("rtk", ["gain"]),
            vec![],
        ),
    ]);

    let result = execute_plan(plan, &runner).await;

    // success stays true — continue_on_failure prevents aborting the plan
    assert!(result.success);
    assert_eq!(result.outputs.len(), 2);
    assert_eq!(result.steps[0].state, StepState::Failed { code: Some(2) });
    assert_eq!(result.steps[1].state, StepState::Succeeded);
}
