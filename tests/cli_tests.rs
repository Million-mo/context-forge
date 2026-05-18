use assert_cmd::Command;

#[test]
fn help_mentions_preview_and_supported_tools() {
    let mut cmd = Command::cargo_bin("context-forge").unwrap();

    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicates::str::contains("RTK"))
        .stdout(predicates::str::contains("Caveman"))
        .stdout(predicates::str::contains("预演模式"));
}
