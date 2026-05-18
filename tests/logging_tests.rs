use context_forge::domain::{
    CommandSpec, ExecutionResult, PlanStep, StepOutput, StepState, ToolId,
};
use context_forge::logging::{default_log_dir, write_session_log};

#[test]
fn default_log_dir_uses_macos_application_support_path() {
    let path = default_log_dir().expect("log directory should resolve");
    let text = path.to_string_lossy();

    assert!(text.contains("Application Support"));
    assert!(text.ends_with("context-forge/logs"));
}

#[test]
fn write_session_log_records_commands_and_outputs() {
    let dir = tempfile::tempdir().unwrap();
    let result = ExecutionResult {
        success: false,
        steps: vec![PlanStep {
            tool: ToolId::Rtk,
            title: "Configure RTK".into(),
            command: CommandSpec::new("rtk", ["init", "-g"]),
            touched_paths: vec!["~/.claude/settings.json".into()],
            state: StepState::Failed { code: Some(2) },
        }],
        outputs: vec![StepOutput {
            command: "rtk init -g".into(),
            code: 2,
            stdout: String::new(),
            stderr: "permission denied".into(),
        }],
    };

    let path = write_session_log(dir.path(), &result).unwrap();
    let contents = std::fs::read_to_string(path).unwrap();

    assert!(contents.contains("success: false"));
    assert!(contents.contains("command: rtk init -g"));
    assert!(contents.contains("stderr: permission denied"));
}
