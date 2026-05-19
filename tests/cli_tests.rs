use assert_cmd::Command;
use predicates::prelude::PredicateBooleanExt;

#[test]
fn help_mentions_supported_tools_and_core_shortcuts() {
    let mut cmd = Command::cargo_bin("context-forge").unwrap();

    cmd.arg("--help")
        .assert()
        .success()
        .stdout(predicates::str::contains("RTK"))
        .stdout(predicates::str::contains("Caveman"))
        .stdout(predicates::str::contains("init"))
        .stdout(predicates::str::contains("Enter"))
        .stdout(predicates::str::contains("q"))
        .stdout(predicates::str::contains("预演模式").not())
        .stdout(predicates::str::contains("details").not());
}
