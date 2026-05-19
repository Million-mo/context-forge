fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str());

    match cmd {
        Some("-h") | Some("--help") => print_help(),
        Some("init") | None => {
            if let Err(error) = context_forge::tui::terminal::run_terminal_app() {
                eprintln!("context-forge: {error:#}");
                std::process::exit(1);
            }
        }
        Some(unknown) => {
            eprintln!("context-forge: unknown command '{unknown}'");
            eprintln!("Usage: context-forge [init]");
            std::process::exit(1);
        }
    }
}

fn print_help() {
    println!(
        "context-forge — macOS-first TUI manager for RTK and Caveman\n\n\
         USAGE:\n  context-forge [COMMAND]\n\n\
         COMMANDS:\n  init         Launch the TUI installer (default)\n\n\
         SHORTCUTS (TUI):\n  Enter        continue / execute\n  Esc          back\n  q            quit\n"
    );
}
