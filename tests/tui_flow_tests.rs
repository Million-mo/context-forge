use context_forge::domain::{StepState, ToolId};
use context_forge::runner::FakeCommandRunner;
use context_forge::tui::state::{AppPage, AppState};

#[tokio::test]
async fn start_scan_builds_plan_for_single_tool() {
    let runner = FakeCommandRunner::new()
        .with_failure("which", ["rtk"], 1, "")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n")
        .with_success("which", ["cargo"], "/Users/me/.cargo/bin/cargo\n");
    let mut app = AppState::new();
    // default is ToolId::Rtk

    app.scan_and_plan(&runner).await;

    assert_eq!(app.page, AppPage::PlanSummary);
    assert!(app
        .plan
        .as_ref()
        .unwrap()
        .steps
        .iter()
        .any(|step| step.tool == ToolId::Rtk));
}

#[tokio::test]
async fn execute_current_plan_runs_individual_steps_and_goes_to_results() {
    let runner = FakeCommandRunner::new()
        .with_failure("which", ["rtk"], 1, "")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n")
        .with_success("which", ["cargo"], "/Users/me/.cargo/bin/cargo\n")
        .with_success(
            "cargo",
            ["install", "--git", "https://github.com/rtk-ai/rtk"],
            "",
        )
        .with_success("rtk", ["init", "-g"], "");
    let mut app = AppState::new();
    app.selection.tool = ToolId::Rtk;
    app.scan_and_plan(&runner).await;

    app.execute_current_plan(&runner).await;

    assert_eq!(app.page, AppPage::Results);
    assert!(app.execution_result.as_ref().unwrap().success);
}

#[tokio::test]
async fn continue_on_failure_does_not_stop_execution() {
    let runner = FakeCommandRunner::new()
        .with_failure("which", ["rtk"], 1, "")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n")
        .with_success("which", ["cargo"], "/Users/me/.cargo/bin/cargo\n")
        .with_failure(
            "cargo",
            ["install", "--git", "https://github.com/rtk-ai/rtk"],
            1,
            "cargo failed",
        )
        .with_failure("brew", ["install", "rtk"], 1, "brew failed")
        .with_success(
            "sh",
            [
                "-c",
                "curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh",
            ],
            "",
        )
        .with_success("rtk", ["init", "-g"], "");

    let mut app = AppState::new();
    app.selection.tool = ToolId::Rtk;
    app.scan_and_plan(&runner).await;

    app.execute_current_plan(&runner).await;

    let result = app.execution_result.as_ref().unwrap();
    // cargo failed → continue (index 0)
    assert_eq!(result.steps[0].state, StepState::Failed { code: Some(1) });
    // brew failed → continue (index 1)
    assert_eq!(result.steps[1].state, StepState::Failed { code: Some(1) });
    // curl script succeeded (index 2)
    assert_eq!(result.steps[2].state, StepState::Succeeded);
    // init succeeded (index 3)
    assert_eq!(result.steps[3].state, StepState::Succeeded);
}
