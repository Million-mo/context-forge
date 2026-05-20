fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str());

    match cmd {
        Some("-h") | Some("--help") => print_help(),
        Some("gain") => {
            let args: Vec<String> = args.into_iter().skip(2).collect();
            run_gain(&args);
        }
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
         COMMANDS:\n  init         Launch the TUI installer (default)\n  gain [..]    Show RTK token savings (passes all args to rtk gain)\n\n\
         SHORTCUTS (TUI):\n  Enter        continue / execute\n  Esc          back\n  q            quit\n"
    );
}

fn run_gain(args: &[String]) {
    use std::process::Command;
    let status = Command::new("rtk")
        .arg("gain")
        .args(args)
        .status()
        .unwrap_or_else(|_| {
            eprintln!("context-forge: rtk not found — install RTK first: https://github.com/rtk-ai/rtk");
            std::process::exit(1);
        });
    if !status.success() {
        std::process::exit(status.code().unwrap_or(1));
    }
}
