fn main() {
    if std::env::args().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return;
    }

    if let Err(error) = context_forge::tui::terminal::run_terminal_app() {
        eprintln!("context-forge: {error:#}");
        std::process::exit(1);
    }
}

fn print_help() {
    println!(
        "context-forge\n\n\
         macOS-first TUI manager for RTK and Caveman.\n\n\
         Supported tools:\n\
           - RTK\n\
           - Caveman\n\n\
         Shortcuts:\n\
           Enter  continue or execute\n\
           D      预演模式 / dry-run\n\
           E      expand command details\n\
           Esc    back\n\
           q      quit\n"
    );
}
