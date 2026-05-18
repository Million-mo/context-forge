use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use directories::ProjectDirs;
use time::macros::format_description;
use time::OffsetDateTime;

use crate::domain::ExecutionResult;

pub fn default_log_dir() -> Option<PathBuf> {
    ProjectDirs::from("", "", "context-forge").map(|dirs| dirs.data_dir().join("logs"))
}

pub fn write_session_log(dir: &Path, result: &ExecutionResult) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let timestamp = OffsetDateTime::now_utc()
        .format(format_description!(
            "[year][month][day]-[hour][minute][second]"
        ))
        .unwrap_or_else(|_| "session".to_owned());
    let path = dir.join(format!("{timestamp}.log"));

    let mut contents = String::new();
    contents.push_str(&format!("success: {}\n", result.success));
    contents.push_str("\nsteps:\n");
    for step in &result.steps {
        contents.push_str(&format!(
            "- tool: {}\n  title: {}\n  command: {}\n  state: {:?}\n",
            step.tool.label(),
            step.title,
            step.command.display(),
            step.state
        ));
    }
    contents.push_str("\noutputs:\n");
    for output in &result.outputs {
        contents.push_str(&format!(
            "- command: {}\n  code: {}\n  stdout: {}\n  stderr: {}\n",
            output.command,
            output.code,
            output.stdout.trim(),
            output.stderr.trim()
        ));
    }

    fs::write(&path, contents)?;
    Ok(path)
}
