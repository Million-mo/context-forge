use context_forge::tui::render::render_to_text_for_test;
use context_forge::tui::state::{AppPage, AppState};

#[test]
fn tool_selection_render_contains_ops_console_title_and_tools() {
    let app = AppState::new();
    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Context Forge"));
    assert!(text.contains("RTK"));
    assert!(text.contains("Caveman"));
    assert!(text.contains("Enter"));
}

#[test]
fn plan_summary_render_mentions_preview_shortcut() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;

    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Plan Summary"));
    assert!(text.contains("D"));
    assert!(text.contains("预演模式"));
}
