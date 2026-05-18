use ratatui::backend::TestBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, Paragraph};
use ratatui::Frame;

use crate::domain::ToolId;
use crate::tui::state::{AppPage, AppState};

pub fn render(frame: &mut Frame<'_>, app: &AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(3),
        ])
        .split(frame.area());

    let header = Paragraph::new(Line::from(vec![
        Span::styled(
            "Context Forge",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  RTK + Caveman Manager"),
    ]))
    .block(Block::default().borders(Borders::ALL));
    frame.render_widget(header, chunks[0]);

    match app.page {
        AppPage::ToolSelection => render_tool_selection(frame, app, chunks[1]),
        AppPage::Scanning => render_message(frame, "Scanning selected tools...", chunks[1]),
        AppPage::PlanSummary => render_plan_summary(frame, app, chunks[1]),
        AppPage::Executing => render_message(frame, "Executing plan...", chunks[1]),
        AppPage::Results => render_results(frame, app, chunks[1]),
    }

    let footer = Paragraph::new("Enter continue   D 预演模式   E details   Esc back")
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(footer, chunks[2]);
}

fn render_tool_selection(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let items: Vec<ListItem> = [ToolId::Rtk, ToolId::Caveman]
        .into_iter()
        .map(|tool| {
            let selected = app.selection.tools.contains(&tool);
            let marker = if selected { "[x]" } else { "[ ]" };
            ListItem::new(format!("{marker} {}", tool.label()))
        })
        .collect();

    let list = List::new(items).block(Block::default().title("Choose tools").borders(Borders::ALL));
    frame.render_widget(list, area);
}

fn render_message(frame: &mut Frame<'_>, message: &str, area: Rect) {
    frame.render_widget(
        Paragraph::new(message).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

fn render_plan_summary(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let mut lines = vec![Line::from("Plan Summary")];
    if let Some(plan) = &app.plan {
        for step in &plan.steps {
            lines.push(Line::from(format!(
                "{}: {} -> {}",
                step.tool.label(),
                step.title,
                step.command.display()
            )));
        }
        lines.push(Line::from(format!(
            "Touched paths: {}",
            plan.touched_paths().join(", ")
        )));
    } else {
        lines.push(Line::from("No plan built yet"));
    }
    lines.push(Line::from(
        "D 预演模式    E details    Enter execute    Esc back",
    ));

    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

fn render_results(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let mut lines = vec![Line::from("Results")];
    if let Some(result) = &app.execution_result {
        lines.push(Line::from(format!("success: {}", result.success)));
        for step in &result.steps {
            lines.push(Line::from(format!(
                "{}: {:?} {}",
                step.tool.label(),
                step.state,
                step.command.display()
            )));
        }
    } else {
        lines.push(Line::from("No execution result"));
    }

    frame.render_widget(
        Paragraph::new(lines).block(Block::default().borders(Borders::ALL)),
        area,
    );
}

pub fn render_to_text_for_test(app: &AppState, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = ratatui::Terminal::new(backend).expect("test terminal");
    terminal.draw(|frame| render(frame, app)).expect("draw frame");
    format!("{:?}", terminal.backend().buffer())
}
