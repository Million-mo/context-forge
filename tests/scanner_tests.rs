use context_forge::domain::ToolId;
use context_forge::runner::{FakeCommandRunner, Output};
use context_forge::scanner::scan_selected_tools;

#[tokio::test]
async fn scan_rtk_detects_correct_identity_and_brew() {
    let runner = FakeCommandRunner::new()
        .with_success("which", ["rtk"], "/Users/me/.local/bin/rtk\n")
        .with_success("rtk", ["gain"], "saved 1200 tokens\n")
        .with_success("rtk", ["init", "--show"], "Hook: installed\n")
        .with_success("which", ["brew"], "/opt/homebrew/bin/brew\n");

    let scan = scan_selected_tools(&runner, &[ToolId::Rtk]).await;

    assert!(scan.rtk_present);
    assert!(scan.rtk_gain_ok);
    assert!(scan.rtk_init_show_ok);
    assert!(scan.brew_available);
}

#[tokio::test]
async fn scan_rtk_marks_wrong_identity_when_gain_fails() {
    let runner = FakeCommandRunner::new()
        .with_success("which", ["rtk"], "/Users/me/.cargo/bin/rtk\n")
        .with_failure("rtk", ["gain"], 2, "unknown command gain\n");

    let scan = scan_selected_tools(&runner, &[ToolId::Rtk]).await;

    assert!(scan.rtk_present);
    assert!(!scan.rtk_gain_ok);
}

#[tokio::test]
async fn scan_caveman_extracts_node_major_version_and_npx() {
    let runner = FakeCommandRunner::new()
        .with_success("node", ["--version"], "v22.16.0\n")
        .with_success("which", ["npx"], "/opt/homebrew/bin/npx\n");

    let scan = scan_selected_tools(&runner, &[ToolId::Caveman]).await;

    assert_eq!(scan.node_major, Some(22));
    assert!(scan.npx_available);
}

#[tokio::test]
async fn scan_caveman_handles_missing_node() {
    let runner = FakeCommandRunner::new()
        .with_output("node", ["--version"], Output::failure(127, "node not found\n"))
        .with_failure("which", ["npx"], 1, "");

    let scan = scan_selected_tools(&runner, &[ToolId::Caveman]).await;

    assert_eq!(scan.node_major, None);
    assert!(!scan.npx_available);
}
