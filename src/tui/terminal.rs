use std::io;

use crossterm::event::{self, Event, KeyCode, KeyModifiers};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::domain::{Action, ExecutionResult, StepOutput, StepState, ToolId};
use crate::runner::CommandRunner;
use crate::scanner;
use crate::tui::render::render;
use crate::tui::state::{AppPage, AppState, KeyCommand};

pub fn run_terminal_app() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Runtime::new()?;
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = runtime.block_on(run_loop(&mut terminal));

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>) -> anyhow::Result<()> {
    let mut app = AppState::new();

    loop {
        terminal.draw(|frame| render(frame, &app))?;

        if let Event::Key(key) = event::read()? {
            match key.code {
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    app.handle(KeyCommand::Quit);
                }
                KeyCode::Char('q') | KeyCode::Char('Q') => app.handle(KeyCommand::Quit),
                KeyCode::Enter => match app.page {
                    AppPage::PluginSelection => {
                        app.handle(KeyCommand::Enter);
                    }
                    AppPage::ActionSelection => {
                        if app.selection.tool == ToolId::Rtk
                            && matches!(
                                app.selection.action,
                                Action::Install | Action::Uninstall | Action::Upgrade
                            )
                        {
                            app.scan = Some(scanner::pre_scan_ai_tools());
                            app.page = AppPage::AIToolSelection;
                        } else {
                            app.scan_and_plan(&crate::runner::RealCommandRunner).await;
                        }
                    }
                    AppPage::AIToolSelection => {
                        app.scan_and_plan(&crate::runner::RealCommandRunner).await;
                    }
                    AppPage::PlanSummary => {
                        app.handle(KeyCommand::Enter);
                        terminal.draw(|frame| render(frame, &app))?;
                        execute_current_plan_with_progress(
                            &mut app,
                            &crate::runner::RealCommandRunner,
                            terminal,
                        )
                        .await?;
                    }
                    _ => app.handle(KeyCommand::Enter),
                },
                KeyCode::Up | KeyCode::Char('k') | KeyCode::Char('K') => {
                    app.handle(KeyCommand::PreviousTool);
                }
                KeyCode::Down | KeyCode::Char('j') | KeyCode::Char('J') => {
                    app.handle(KeyCommand::NextTool);
                }
                KeyCode::Char(' ') => app.handle(KeyCommand::ToggleTool),
                KeyCode::Esc => app.handle(KeyCommand::Back),
                _ => {}
            }
        }

        if app.should_quit {
            break;
        }
    }

    Ok(())
}

async fn execute_current_plan_with_progress<B: ratatui::backend::Backend>(
    app: &mut AppState,
    runner: &dyn CommandRunner,
    terminal: &mut Terminal<B>,
) -> anyhow::Result<()> {
    app.page = AppPage::Executing;
    let Some(mut plan) = app.plan.clone() else {
        app.page = AppPage::Results;
        return Ok(());
    };

    let mut outputs = Vec::new();
    let mut success = true;

    for index in 0..plan.steps.len() {
        plan.steps[index].state = StepState::Running;
        app.plan = Some(plan.clone());
        terminal.draw(|frame| render(frame, app))?;

        let output = {
            let tail = app.live_tail.clone();
            let mut fut = runner.run_with_tail(&plan.steps[index].command, &tail);
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(300));
            loop {
                tokio::select! {
                    result = &mut fut => {
                        break result;
                    }
                    _ = tick.tick() => {
                        terminal.draw(|frame| render(frame, app))?;
                    }
                }
            }
        };

        outputs.push(StepOutput {
            command: plan.steps[index].command.display(),
            code: output.code,
            stdout: output.stdout.clone(),
            stderr: output.stderr.clone(),
        });

        if output.succeeded() {
            plan.steps[index].state = StepState::Succeeded;
        } else {
            plan.steps[index].state = StepState::Failed {
                code: Some(output.code),
            };
            if !plan.steps[index].continue_on_failure {
                success = false;
                app.plan = Some(plan.clone());
                terminal.draw(|frame| render(frame, app))?;
                break;
            }
        }

        app.plan = Some(plan.clone());
        terminal.draw(|frame| render(frame, app))?;
    }

    app.execution_result = Some(ExecutionResult {
        success,
        steps: plan.steps,
        outputs,
    });
    app.page = AppPage::Results;
    Ok(())
}
