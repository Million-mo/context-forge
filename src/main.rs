fn main() {
    if let Err(error) = run() {
        eprintln!("context-forge: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> anyhow::Result<()> {
    println!("context-forge TUI coming online");
    Ok(())
}
