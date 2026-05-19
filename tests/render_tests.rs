use context_forge::domain::{
    CommandSpec, ExecutionResult, Plan, PlanStep, StepOutput, StepState, ToolId,
};
use context_forge::tui::render::{app_area, render_to_text_for_test};
use context_forge::tui::state::{AppPage, AppState};
use ratatui::layout::Rect;

#[test]
fn plugin_selection_render_contains_rtk_and_caveman() {
    let app = AppState::new();
    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Context Forge"));
    assert!(text.contains("RTK"));
    assert!(text.contains("Caveman"));
    assert!(text.contains("Enter"));
    assert!(text.contains("A lightweight installer for RTK and Caveman"));
    assert!(text.contains("◉"));
    assert!(text.contains("›"));
    assert!(text.contains("q quit"));
    assert!(text.contains("Select plugin"));
}

#[test]
fn plan_summary_render_shows_only_core_actions() {
    let mut app = AppState::new();
    app.page = AppPage::PlanSummary;
    app.plan = Some(Plan::new(vec![
        PlanStep::new(
            ToolId::Rtk,
            "Verify RTK identity",
            CommandSpec::new("rtk", ["gain"]),
            vec!["~/.claude/settings.json".into(), "~/.claude/hooks/".into()],
        ),
        PlanStep::new(
            ToolId::Rtk,
            "Verify RTK hook status",
            CommandSpec::new("rtk", ["init", "--show"]),
            vec!["~/.claude/settings.json".into(), "~/.claude/RTK.md".into()],
        ),
    ]));

    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Ready to install"));
    assert!(text.contains("2 installation steps"));
    assert!(text.contains("1. RTK Verify RTK identity"));
    assert!(text.contains("rtk gain"));
    assert!(text.contains("Will touch 3 paths"));
    assert!(text.contains("Enter execute"));
    assert!(text.contains("Esc back"));
    assert!(text.contains("q quit"));
    assert!(!text.contains("Touched paths:"));
    assert!(!text.contains("↑↓ navigate"));
    assert!(!text.contains("Space toggle"));
    assert!(!text.contains("预演模式"));
    assert!(!text.contains("details"));
}

#[test]
fn executing_render_explains_external_commands_are_running() {
    let mut app = AppState::new();
    app.page = AppPage::Executing;

    let text = render_to_text_for_test(&app, 80, 24);

    assert!(text.contains("Running external commands"));
    assert!(text.contains("please wait"));
}

#[test]
fn executing_render_shows_step_progress_and_current_command() {
    let mut app = AppState::new();
    app.page = AppPage::Executing;
    let mut running = PlanStep::new(
        ToolId::Caveman,
        "Install Caveman",
        CommandSpec::new("npx", ["-y", "github:JuliusBrussee/caveman", "--all"]),
        vec![],
    );
    running.state = StepState::Running;
    app.plan = Some(Plan::new(vec![running]));

    let text = render_to_text_for_test(&app, 100, 24);

    assert!(text.contains("Running external commands"));
    assert!(text.contains("↻ Caveman Install Caveman"));
    assert!(text.contains("npx -y github:JuliusBrussee/caveman --all"));
}

#[test]
fn results_render_shows_step_outputs() {
    let mut app = AppState::new();
    app.page = AppPage::Results;
    let mut step = PlanStep::new(
        ToolId::Rtk,
        "Verify RTK identity",
        CommandSpec::new("rtk", ["gain"]),
        vec![],
    );
    step.state = StepState::Succeeded;
    app.execution_result = Some(ExecutionResult {
        success: true,
        steps: vec![step],
        outputs: vec![StepOutput {
            command: "rtk gain".into(),
            code: 0,
            stdout: "RTK identity OK\n".into(),
            stderr: String::new(),
        }],
    });

    let text = render_to_text_for_test(&app, 100, 24);

    assert!(text.contains("Completed 1/1 steps"));
    assert!(text.contains("✓ RTK Verify RTK identity"));
    assert!(text.contains("RTK identity OK"));
}

#[test]
fn app_area_is_centered_and_compact_on_large_terminals() {
    let area = app_area(Rect::new(0, 0, 120, 40));

    assert_eq!(area, Rect::new(16, 11, 88, 18));
}

#[test]
fn app_area_uses_available_width_on_narrow_terminals() {
    let area = app_area(Rect::new(0, 0, 72, 20));

    assert_eq!(area, Rect::new(0, 1, 72, 18));
}
