use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, BufReader};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

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

/// Shared live-output buffer. The streaming runner appends lines;
/// the TUI reads and drains them on each draw.
#[derive(Clone, Default)]
pub struct LiveTail {
    lines: Arc<Mutex<Vec<String>>>,
}

impl LiveTail {
    pub fn new() -> Self {
        Self::default()
    }

    fn push(&self, line: &str) {
        if let Ok(mut guard) = self.lines.lock() {
            guard.push(line.to_owned());
        }
    }

    /// Take all buffered lines, leaving the buffer empty.
    pub fn drain(&self) -> Vec<String> {
        let mut guard = self.lines.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
    }
}

pub trait CommandRunner: Send + Sync {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a>;

    /// Run a command, appending live stdout/stderr lines to `tail` as they arrive.
    /// The TUI reads `tail.drain()` on each draw to show progress.
    fn run_with_tail<'a>(
        &'a self,
        command: &'a CommandSpec,
        tail: &'a LiveTail,
    ) -> Pin<Box<dyn Future<Output = Output> + Send + 'a>>;
}

#[derive(Default)]
pub struct RealCommandRunner;

impl CommandRunner for RealCommandRunner {
    fn run<'a>(&'a self, command: &'a CommandSpec) -> RunnerFuture<'a> {
        Box::pin(async move {
            let program = command.program.clone();
            let args = command.args.clone();
            tokio::task::spawn_blocking(move || run_sync(&program, &args, None))
                .await
                .unwrap_or_else(|e| Output::failure(1, e.to_string()))
        })
    }

    fn run_with_tail<'a>(
        &'a self,
        command: &'a CommandSpec,
        tail: &'a LiveTail,
    ) -> Pin<Box<dyn Future<Output = Output> + Send + 'a>> {
        Box::pin(async move {
            let program = command.program.clone();
            let args = command.args.clone();
            let tail = tail.clone();
            tokio::task::spawn_blocking(move || run_sync(&program, &args, Some(&tail)))
                .await
                .unwrap_or_else(|e| Output::failure(1, e.to_string()))
        })
    }
}

fn run_sync(program: &str, args: &[String], tail: Option<&LiveTail>) -> Output {
    let mut child = match std::process::Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            let msg = error.to_string();
            if let Some(t) = tail {
                t.push(&msg);
            }
            return Output::failure(127, msg);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Read stdout in a background thread, pushing lines to tail live
    let stdout_handle: Option<std::thread::JoinHandle<String>> = stdout.map(|pipe| {
        std::thread::spawn(move || {
            let reader = BufReader::new(pipe);
            let mut collected = String::new();
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        collected.push_str(&l);
                        collected.push('\n');
                    }
                    Err(_) => break,
                }
            }
            collected
        })
    });

    let stderr_handle: Option<std::thread::JoinHandle<String>> = stderr.map(|pipe| {
        let tail_clone = tail.cloned();
        std::thread::spawn(move || {
            let reader = BufReader::new(pipe);
            let mut collected = String::new();
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if let Some(ref t) = tail_clone {
                            t.push(&l);
                        }
                        collected.push_str(&l);
                        collected.push('\n');
                    }
                    Err(_) => break,
                }
            }
            collected
        })
    });

    let status = child.wait();
    let code = status.map(|s| s.code().unwrap_or(1)).unwrap_or(1);

    let stdout_str = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr_str = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();

    Output {
        code,
        stdout: stdout_str,
        stderr: stderr_str,
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
        self.outputs
            .insert(key(program, args), Output::success(stdout));
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
            self.outputs
                .get(&command.display())
                .cloned()
                .unwrap_or_else(|| {
                    Output::failure(127, format!("no fake output for {}", command.display()))
                })
        })
    }

    fn run_with_tail<'a>(
        &'a self,
        command: &'a CommandSpec,
        tail: &'a LiveTail,
    ) -> Pin<Box<dyn Future<Output = Output> + Send + 'a>> {
        Box::pin(async move {
            let output = self.run(command).await;
            for line in output.stdout.lines() {
                tail.push(line);
            }
            for line in output.stderr.lines() {
                tail.push(line);
            }
            output
        })
    }
}

fn key<const N: usize>(program: &str, args: [&str; N]) -> String {
    CommandSpec::new(program, args).display()
}
