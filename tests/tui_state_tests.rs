use context_forge::domain::{Action, ExecutionMode, ToolId};
use context_forge::tui::state::{AppPage, AppState, KeyCommand};

#[test]
fn app_starts_fast_on_tool_selection_without_scan() {
    let app = AppState::new();

    assert_eq!(app.page, AppPage::ToolSelection);
    assert_eq!(app.selection.tools, vec![ToolId::Rtk, ToolId::Caveman]);
    assert!(!app.scan_started);
}

#[test]
fn pressing_enter_on_tool_selection_moves_to_scanning() {
    let mut app = AppState::new();

    app.handle(KeyCommand::Enter);

    assert_eq!(app.page, AppPage::Scanning);
    assert!(app.scan_started);
}

#[test]
fn pressing_d_on_plan_summary_toggles_preview_mode() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    app.handle(KeyCommand::Preview);

    assert_eq!(app.selection.mode, ExecutionMode::Preview);
}

#[test]
fn pressing_escape_from_plan_summary_returns_to_tool_selection() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    app.handle(KeyCommand::Back);

    assert_eq!(app.page, AppPage::ToolSelection);
}

#[test]
fn action_cycle_moves_from_recommended_to_install() {
    let mut app = AppState::new();

    app.handle(KeyCommand::NextAction);

    assert_eq!(app.selection.action, Action::Install);
}
