fn main() {
    if let Err(error) = context_forge::tui::terminal::run_terminal_app() {
        eprintln!("context-forge: {error:#}");
        std::process::exit(1);
    }
}
