use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;

use crate::domain::CommandSpec;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn success(stdout: impl Into<String>) -> Self {
        Self {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }

    pub fn failure(code: i32, stderr: impl Into<String>) -> Self {
        Self {
            code,
            stdout: String::new(),
            stderr: stderr.into(),
        }
    }

    pub fn succeeded(&self) -> bool {
        self.code == 0
    }
}

pub type RunnerFuture<'a> = Pin<Box<dyn Future<Output = Output> + Send + 'a>>;

pub trait CommandRunner: Send + Sync {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a>;
}

#[derive(Default)]
pub struct RealCommandRunner;

impl CommandRunner for RealCommandRunner {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a> {
        Box::pin(async move {
            match tokio::process::Command::new(&command.program)
                .args(&command.args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .await
            {
                Ok(output) => Output {
                    code: output.status.code().unwrap_or(1),
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
                },
                Err(error) => Output {
                    code: 127,
                    stdout: String::new(),
                    stderr: error.to_string(),
                },
            }
        })
    }
}

#[derive(Clone, Default)]
pub struct FakeCommandRunner {
    outputs: HashMap<String, Output>,
}

impl FakeCommandRunner {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_success<const N: usize>(
        mut self,
        program: &str,
        args: [&str; N],
        stdout: &str,
    ) -> Self {
        self.outputs.insert(key(program, args), Output::success(stdout));
        self
    }

    pub fn with_failure<const N: usize>(
        mut self,
        program: &str,
        args: [&str; N],
        code: i32,
        stderr: &str,
    ) -> Self {
        self.outputs
            .insert(key(program, args), Output::failure(code, stderr));
        self
    }

    pub fn with_output<const N: usize>(
        mut self,
        program: &str,
        args: [&str; N],
        output: Output,
    ) -> Self {
        self.outputs.insert(key(program, args), output);
        self
    }
}

impl CommandRunner for FakeCommandRunner {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a> {
        Box::pin(async move {
            self.outputs.get(&command.display()).cloned().unwrap_or_else(|| {
                Output::failure(127, format!("no fake output for {}", command.display()))
            })
        })
    }
}

fn key<const N: usize>(program: &str, args: [&str; N]) -> String {
    CommandSpec::new(program, args).display()
}
