use context_forge::domain::{Action, ToolId};
use context_forge::tui::state::{AppPage, AppState, KeyCommand};

#[test]
fn app_starts_on_plugin_selection() {
    let app = AppState::new();

    assert_eq!(app.page, AppPage::PluginSelection);
    assert_eq!(app.selection.tool, ToolId::Rtk);
}

#[test]
fn pressing_enter_on_plugin_selection_moves_to_action_selection() {
    let mut app = AppState::new();

    app.handle(KeyCommand::Enter);

    assert_eq!(app.page, AppPage::ActionSelection);
    assert_eq!(app.selection.tool, ToolId::Rtk);
    assert_eq!(app.selection.action, Action::Install);
}

#[test]
fn pressing_down_on_plugin_selection_moves_highlight_to_caveman() {
    let mut app = AppState::new();

    app.handle(KeyCommand::NextTool);

    assert_eq!(app.highlighted_plugin_index, 1);
}

#[test]
fn pressing_enter_on_plugin_selection_sets_tool() {
    let mut app = AppState::new();
    app.handle(KeyCommand::NextTool); // highlight Caveman

    app.handle(KeyCommand::Enter);

    assert_eq!(app.selection.tool, ToolId::Caveman);
    assert_eq!(app.page, AppPage::ActionSelection);
}

#[test]
fn pressing_escape_from_plan_summary_returns_to_action_selection() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    app.handle(KeyCommand::Back);

    assert_eq!(app.page, AppPage::ActionSelection);
}

#[test]
fn back_from_results_returns_to_plugin_selection() {
    let mut app = AppState::new();
    app.page = AppPage::Results;

    app.handle(KeyCommand::Back);

    assert_eq!(app.page, AppPage::PluginSelection);
}

#[test]
fn pressing_quit_requests_app_exit() {
    let mut app = AppState::new();

    app.handle(KeyCommand::Quit);

    assert!(app.should_quit);
}

#[test]
fn pressing_escape_on_plugin_selection_requests_app_exit() {
    let mut app = AppState::new();

    app.handle(KeyCommand::Back);

    assert!(app.should_quit);
}

#[test]
fn pressing_escape_on_action_selection_goes_back_to_plugin_selection() {
    let mut app = AppState::new();
    app.handle(KeyCommand::Enter); // to ActionSelection

    app.handle(KeyCommand::Back);

    assert_eq!(app.page, AppPage::PluginSelection);
}

#[test]
fn action_navigate_up_down_changes_highlight() {
    let mut app = AppState::new();
    app.handle(KeyCommand::Enter); // to ActionSelection

    app.handle(KeyCommand::NextTool);

    assert_eq!(app.highlighted_action_index, 1);
}

#[test]
fn action_toggle_changes_selected_action() {
    let mut app = AppState::new();
    app.handle(KeyCommand::Enter); // to ActionSelection

    app.handle(KeyCommand::ToggleTool);

    assert_eq!(app.selection.action, Action::Install);
}

#[test]
fn pressing_escape_from_ai_tool_selection_goes_back_to_action_selection() {
    let mut app = AppState::new();
    app.page = AppPage::AIToolSelection;

    app.handle(KeyCommand::Back);

    assert_eq!(app.page, AppPage::ActionSelection);
}
