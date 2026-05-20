use std::path::PathBuf;

use crate::domain::{AiTool, CommandSpec, ScanReport, ToolId};
use crate::runner::CommandRunner;

pub async fn scan_selected_tools(runner: &dyn CommandRunner, tools: &[ToolId]) -> ScanReport {
    let mut builder = ScanReport::builder();

    if tools.contains(&ToolId::Rtk) {
        let rtk_present = run_ok(runner, CommandSpec::new("which", ["rtk"])).await;

        let (rtk_gain_ok, rtk_gain_summary) = if rtk_present {
            let output = runner.run(&CommandSpec::new("rtk", ["gain"])).await;
            let ok = output.succeeded();
            let summary = if ok {
                extract_gain_summary(&output.stdout)
            } else {
                None
            };
            (ok, summary)
        } else {
            (false, None)
        };

        let rtk_init_show_ok =
            rtk_present && run_ok(runner, CommandSpec::new("rtk", ["init", "--show"])).await;
        let brew_available = run_ok(runner, CommandSpec::new("which", ["brew"])).await;
        let cargo_available = run_ok(runner, CommandSpec::new("which", ["cargo"])).await;

        let rtk_version = if rtk_present {
            let output = runner.run(&CommandSpec::new("rtk", ["--version"])).await;
            output.stdout.trim().to_owned().into()
        } else {
            None
        };

        let home = dirs_home();
        let installed_ai_tools = detect_installed_ai_tools(&home);

        builder = builder
            .rtk_present(rtk_present)
            .rtk_version(rtk_version.as_deref())
            .rtk_gain_ok(rtk_gain_ok)
            .rtk_gain_summary(rtk_gain_summary.as_deref())
            .rtk_init_show_ok(rtk_init_show_ok)
            .brew_available(brew_available)
            .cargo_available(cargo_available)
            .rtk_installed_ai_tools(installed_ai_tools);
    }

    if tools.contains(&ToolId::Caveman) {
        let node_output = runner.run(&CommandSpec::new("node", ["--version"])).await;
        let node_major = if node_output.succeeded() {
            parse_node_major(&node_output.stdout)
        } else {
            None
        };
        let npx_available = run_ok(runner, CommandSpec::new("which", ["npx"])).await;

        builder = builder
            .node_major(node_major)
            .npx_available(npx_available);
    }

    builder.build()
}

/// Lightweight pre-scan: file-system-only detection without running commands.
/// Used when transitioning to AIToolSelection page before full scan.
pub fn pre_scan_ai_tools() -> ScanReport {
    let home = dirs_home();
    let installed = detect_installed_ai_tools(&home);
    let rtk_present = find_rtk_binary(&home);
    ScanReport::builder()
        .rtk_present(rtk_present)
        .rtk_installed_ai_tools(installed)
        .build()
}

/// Startup scan: detects RTK presence and captures `rtk gain` summary
/// so PluginSelection page can show token stats immediately.
pub async fn startup_scan(runner: &dyn CommandRunner) -> ScanReport {
    let home = dirs_home();
    let rtk_present = find_rtk_binary(&home);

    let rtk_gain_summary = if rtk_present {
        let output = runner.run(&CommandSpec::new("rtk", ["gain"])).await;
        if output.succeeded() {
            extract_gain_summary(&output.stdout)
        } else {
            None
        }
    } else {
        None
    };

    ScanReport::builder()
        .rtk_present(rtk_present)
        .rtk_gain_summary(rtk_gain_summary.as_deref())
        .build()
}

/// Check known RTK install paths without running commands.
fn find_rtk_binary(home: &std::path::Path) -> bool {
    let candidates: &[&str] = &[
        "/opt/homebrew/bin/rtk",
        "/usr/local/bin/rtk",
    ];
    let home_candidates = [
        home.join(".cargo/bin/rtk"),
        home.join(".local/bin/rtk"),
    ];

    candidates.iter().any(|p| std::path::Path::new(p).exists())
        || home_candidates.iter().any(|p| p.exists())
}

/// File-system-based detection of installed AI tools.
/// Uses the home directory path provided by the caller (test-friendly).
pub fn detect_installed_ai_tools(home: &std::path::Path) -> Vec<AiTool> {
    let mut installed = Vec::new();
    let all = crate::domain::selectable_ai_tools();
    for tool in &all {
        if ai_tool_configured(home, *tool) {
            installed.push(*tool);
        }
    }
    installed.sort();
    installed
}

fn ai_tool_configured(home: &std::path::Path, tool: AiTool) -> bool {
    match tool {
        AiTool::Claude => settings_json_has_rtk(home),
        AiTool::Cursor => home.join(".cursor").join("hooks.json").exists(),
        AiTool::Windsurf => home.join(".windsurf").is_dir(),
        AiTool::Cline => home.join(".cline").is_dir(),
        AiTool::KiloCode => home.join(".kilocode").is_dir(),
        AiTool::Antigravity => home.join(".antigravity").is_dir(),
        AiTool::Hermes => home
            .join(".hermes")
            .join("plugins")
            .join("rtk-rewrite")
            .is_dir(),
        AiTool::OpenCode => home
            .join(".config")
            .join("opencode")
            .join("plugins")
            .join("rtk.ts")
            .exists(),
        AiTool::Gemini => home.join(".gemini").is_dir(),
        AiTool::Codex => home.join(".codex").is_dir(),
        AiTool::Copilot => home.join(".copilot").is_dir(),
    }
}

fn settings_json_has_rtk(home: &std::path::Path) -> bool {
    let path = home.join(".claude").join("settings.json");
    match std::fs::read_to_string(&path) {
        Ok(contents) => contents.contains("rtk hook"),
        Err(_) => false,
    }
}

/// Extract the top-line summary from `rtk gain` output:
/// "Tokens saved: 7.4K (73.3%)"
fn extract_gain_summary(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if line.contains("Tokens saved:") {
            return Some(line.trim().to_owned());
        }
    }
    None
}

fn dirs_home() -> PathBuf {
    directories::BaseDirs::new()
        .map(|b| b.home_dir().to_owned())
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("~"))
}

async fn run_ok(runner: &dyn CommandRunner, command: CommandSpec) -> bool {
    runner.run(&command).await.succeeded()
}

fn parse_node_major(stdout: &str) -> Option<u32> {
    stdout
        .trim()
        .strip_prefix('v')
        .unwrap_or_else(|| stdout.trim())
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
}

#[cfg(test)]
pub fn test_home() -> PathBuf {
    std::env::temp_dir().join("context-forge-test-home")
}
