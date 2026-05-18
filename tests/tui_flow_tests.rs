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
    assert!(app
        .plan
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .any(|step| step.tool == ToolId::Rtk));
    assert!(app
        .plan
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .any(|step| step.tool == ToolId::Caveman));
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
