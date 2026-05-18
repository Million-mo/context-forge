use std::io;

use crossterm::event::{self, Event, KeyCode};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;

use crate::tui::render::render;
use crate::tui::state::{AppState, KeyCommand};

pub fn run_terminal_app() -> anyhow::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    let result = run_loop(&mut terminal);

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

fn run_loop<B: ratatui::backend::Backend>(terminal: &mut Terminal<B>) -> anyhow::Result<()> {
    let mut app = AppState::new();

    loop {
        terminal.draw(|frame| render(frame, &app))?;

        if let Event::Key(key) = event::read()? {
            match key.code {
                KeyCode::Char('q') => break,
                KeyCode::Enter => app.handle(KeyCommand::Enter),
                KeyCode::Char('d') | KeyCode::Char('D') => app.handle(KeyCommand::Preview),
                KeyCode::Char('e') | KeyCode::Char('E') => app.handle(KeyCommand::Expand),
                KeyCode::Esc => app.handle(KeyCommand::Back),
                KeyCode::Tab => app.handle(KeyCommand::NextAction),
                _ => {}
            }
        }
    }

    Ok(())
}
