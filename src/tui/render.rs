use ratatui::backend::TestBackend;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{List, ListItem, Paragraph};
use ratatui::Frame;

use crate::domain::{selectable_ai_tools, StepState};
use crate::tui::state::{selectable_actions, selectable_plugins, AppPage, AppState};

pub fn render(frame: &mut Frame<'_>, app: &AppState) {
    let area = app_area(frame.area());
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4),
            Constraint::Min(8),
            Constraint::Length(2),
        ])
        .split(area);

    let header = Paragraph::new(vec![
        Line::from(vec![
            Span::styled(
                "Context Forge",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  RTK + Caveman Manager"),
        ]),
        Line::from(Span::styled(
            "A lightweight installer for RTK and Caveman",
            Style::default().fg(Color::DarkGray),
        )),
    ]);
    frame.render_widget(header, chunks[0]);

    match app.page {
        AppPage::PluginSelection => render_plugin_selection(frame, app, chunks[1]),
        AppPage::ActionSelection => render_action_selection(frame, app, chunks[1]),
        AppPage::AIToolSelection => render_ai_tool_selection(frame, app, chunks[1]),
        AppPage::Scanning => render_message(frame, "Scanning selected tools...", chunks[1]),
        AppPage::PlanSummary => render_plan_summary(frame, app, chunks[1]),
        AppPage::Executing => render_executing(frame, app, chunks[1]),
        AppPage::Results => render_results(frame, app, chunks[1]),
    }

    let footer = Paragraph::new(footer_line(app.page));
    frame.render_widget(footer, chunks[2]);
}

pub fn app_area(area: Rect) -> Rect {
    let width = area.width.min(88);
    let height = area.height.min(18);
    let x = area.x + area.width.saturating_sub(width) / 2;
    let y = area.y + area.height.saturating_sub(height) / 2;

    Rect::new(x, y, width, height)
}

fn render_plugin_selection(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let items: Vec<ListItem> = selectable_plugins()
        .iter()
        .enumerate()
        .map(|(index, plugin)| {
            let selected = app.selection.tool == *plugin;
            let marker = if selected { "◉" } else { "○" };
            let cursor = if index == app.highlighted_plugin_index {
                "›"
            } else {
                " "
            };
            let style = if index == app.highlighted_plugin_index {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(vec![
                Span::styled(cursor, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(
                    marker,
                    Style::default().fg(if selected {
                        Color::Green
                    } else {
                        Color::DarkGray
                    }),
                ),
                Span::raw(" "),
                Span::styled(plugin.label(), style),
            ]))
        })
        .collect();

    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            "Select plugin",
            Style::default().add_modifier(Modifier::BOLD),
        ),
    ]));
    let inner = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(4)])
        .split(area);
    frame.render_widget(title, inner[0]);

    let list = List::new(items);
    frame.render_widget(list, inner[1]);
}

fn render_action_selection(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let items: Vec<ListItem> = selectable_actions()
        .iter()
        .enumerate()
        .map(|(index, action)| {
            let selected = app.selection.action == *action;
            let marker = if selected { "◉" } else { "○" };
            let cursor = if index == app.highlighted_action_index {
                "›"
            } else {
                " "
            };
            let style = if index == app.highlighted_action_index {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            };
            ListItem::new(Line::from(vec![
                Span::styled(cursor, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(
                    marker,
                    Style::default().fg(if selected {
                        Color::Green
                    } else {
                        Color::DarkGray
                    }),
                ),
                Span::raw(" "),
                Span::styled(action.label(), style),
            ]))
        })
        .collect();

    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            format!("{} — choose action", app.selection.tool.label()),
            Style::default().add_modifier(Modifier::BOLD),
        ),
    ]));
    let inner = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(4)])
        .split(area);
    frame.render_widget(title, inner[0]);

    let list = List::new(items);
    frame.render_widget(list, inner[1]);
}

fn render_ai_tool_selection(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let tools = selectable_ai_tools();
    let installed: Vec<_> = app
        .scan
        .as_ref()
        .map(|s| s.rtk_installed_ai_tools.clone())
        .unwrap_or_default();

    let items: Vec<ListItem> = tools
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let selected = app.selection.ai_tools.contains(tool);
            let already_installed = installed.contains(tool);
            let marker = if selected { "◉" } else { "○" };
            let cursor = if index == app.highlighted_ai_tool_index {
                "›"
            } else {
                " "
            };
            let style = if index == app.highlighted_ai_tool_index {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default()
            };

            let mut spans = vec![
                Span::styled(cursor, Style::default().fg(Color::Cyan)),
                Span::raw(" "),
                Span::styled(
                    marker,
                    Style::default().fg(if selected {
                        Color::Green
                    } else {
                        Color::DarkGray
                    }),
                ),
                Span::raw(" "),
                Span::styled(tool.label(), style),
            ];

            if already_installed {
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    "[installed]",
                    Style::default().fg(Color::Yellow),
                ));
            }

            ListItem::new(Line::from(spans))
        })
        .collect();

    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            "Select AI tools for RTK integration",
            Style::default().add_modifier(Modifier::BOLD),
        ),
    ]));
    let inner = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(4)])
        .split(area);
    frame.render_widget(title, inner[0]);

    let list = List::new(items);
    frame.render_widget(list, inner[1]);
}

fn render_message(frame: &mut Frame<'_>, message: &str, area: Rect) {
    frame.render_widget(Paragraph::new(message), area);
}

fn render_executing(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let mut lines = vec![
        Line::from("Running external commands..."),
        Line::from("please wait. Long installs can take a minute or two."),
        Line::from(""),
    ];

    if let Some(plan) = &app.plan {
        for step in &plan.steps {
            let icon = match step.state {
                StepState::Pending => "○",
                StepState::Running => "↻",
                StepState::Succeeded => "✓",
                StepState::Skipped => "-",
                StepState::Failed { .. } => "×",
            };
            lines.push(Line::from(format!(
                "{icon} {} {}",
                step.tool.label(),
                step.title
            )));
            if step.state == StepState::Running {
                lines.push(Line::from(format!("  {}", step.command.display())));
            }
        }
    }

    // Show live output lines from the running command
    let tail_lines: Vec<String> = app.live_tail.drain();
    if !tail_lines.is_empty() {
        lines.push(Line::from(""));
        lines.push(Line::from("── output ──────────────────────────────"));
        for line in tail_lines.iter().rev().take(20) {
            lines.push(Line::from(format!("  {line}")));
        }
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn render_plan_summary(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let mut lines = Vec::new();
    if let Some(plan) = &app.plan {
        lines.push(Line::from(format!(
            "Ready to install: {} installation steps",
            plan.steps.len()
        )));
        lines.push(Line::from(""));
        for (index, step) in plan.steps.iter().enumerate() {
            lines.push(Line::from(format!(
                "{}. {} {}",
                index + 1,
                step.tool.label(),
                step.title
            )));
            lines.push(Line::from(format!("   {}", step.command.display())));
        }
        lines.push(Line::from(""));
        lines.push(Line::from(path_summary(plan.touched_paths())));
    } else {
        lines.push(Line::from("No plan built yet"));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn render_results(frame: &mut Frame<'_>, app: &AppState, area: Rect) {
    let mut lines = Vec::new();
    if let Some(result) = &app.execution_result {
        let completed = result
            .steps
            .iter()
            .filter(|step| step.state.is_terminal())
            .count();
        let heading = if result.success {
            format!("Completed {completed}/{} steps", result.steps.len())
        } else {
            format!("Failed after {completed}/{} steps", result.steps.len())
        };
        lines.push(Line::from(heading));
        lines.push(Line::from(""));

        for (index, step) in result.steps.iter().enumerate() {
            let icon = match step.state {
                StepState::Pending => "○",
                StepState::Running => "↻",
                StepState::Succeeded => "✓",
                StepState::Skipped => "-",
                StepState::Failed { .. } => "×",
            };
            lines.push(Line::from(format!(
                "{icon} {} {}",
                step.tool.label(),
                step.title
            )));
            if let Some(output) = result.outputs.get(index).and_then(output_summary) {
                lines.push(Line::from(format!("  {output}")));
            }
        }
    } else {
        lines.push(Line::from("No execution result"));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

pub fn render_to_text_for_test(app: &AppState, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = ratatui::Terminal::new(backend).expect("test terminal");
    terminal
        .draw(|frame| render(frame, app))
        .expect("draw frame");
    format!("{:?}", terminal.backend().buffer())
}

fn footer_line(page: AppPage) -> Line<'static> {
    match page {
        AppPage::PluginSelection => Line::from(vec![
            Span::styled("↑↓", Style::default().fg(Color::Cyan)),
            Span::raw(" navigate • "),
            Span::styled("Enter", Style::default().fg(Color::Cyan)),
            Span::raw(" select • "),
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ]),
        AppPage::ActionSelection => Line::from(vec![
            Span::styled("↑↓", Style::default().fg(Color::Cyan)),
            Span::raw(" navigate • "),
            Span::styled("Space", Style::default().fg(Color::Cyan)),
            Span::raw(" choose • "),
            Span::styled("Enter", Style::default().fg(Color::Cyan)),
            Span::raw(" continue • "),
            Span::styled("Esc", Style::default().fg(Color::Cyan)),
            Span::raw(" back • "),
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ]),
        AppPage::AIToolSelection => Line::from(vec![
            Span::styled("↑↓", Style::default().fg(Color::Cyan)),
            Span::raw(" navigate • "),
            Span::styled("Space", Style::default().fg(Color::Cyan)),
            Span::raw(" toggle • "),
            Span::styled("Esc", Style::default().fg(Color::Cyan)),
            Span::raw(" back • "),
            Span::styled("Enter", Style::default().fg(Color::Cyan)),
            Span::raw(" continue • "),
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ]),
        AppPage::PlanSummary => Line::from(vec![
            Span::styled("Enter", Style::default().fg(Color::Cyan)),
            Span::raw(" execute • "),
            Span::styled("Esc", Style::default().fg(Color::Cyan)),
            Span::raw(" back • "),
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ]),
        AppPage::Results => Line::from(vec![
            Span::styled("Esc", Style::default().fg(Color::Cyan)),
            Span::raw(" exit • "),
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ]),
        AppPage::Scanning | AppPage::Executing => Line::from(vec![
            Span::styled("q", Style::default().fg(Color::Cyan)),
            Span::raw(" quit"),
        ]),
    }
}

fn path_summary(paths: Vec<&str>) -> String {
    if paths.is_empty() {
        return "No filesystem paths will be touched".to_owned();
    }

    let preview = paths.iter().take(2).copied().collect::<Vec<_>>().join(", ");
    let suffix = if paths.len() > 2 {
        format!(", +{} more", paths.len() - 2)
    } else {
        String::new()
    };

    format!("Will touch {} paths: {preview}{suffix}", paths.len())
}

fn output_summary(output: &crate::domain::StepOutput) -> Option<String> {
    if output.code == 0 {
        let text = output.stdout.trim();
        if text.is_empty() {
            return None;
        }
        return Some(text.lines().next().unwrap_or_default().to_owned());
    }

    // On failure, prefer stderr. If stderr empty, show last stdout line —
    // errors usually appear at the end, not the beginning.
    let stderr = output.stderr.trim();
    if !stderr.is_empty() {
        return Some(stderr.lines().next().unwrap_or_default().to_owned());
    }

    let stdout = output.stdout.trim();
    if stdout.is_empty() {
        return None;
    }
    Some(stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default().to_owned())
}
