use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Install,
    Uninstall,
    Upgrade,
}

impl Default for Action {
    fn default() -> Self {
        Action::Install
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum ToolId {
    Rtk,
    Caveman,
}

impl ToolId {
    pub fn label(self) -> &'static str {
        match self {
            ToolId::Rtk => "RTK",
            ToolId::Caveman => "Caveman",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum AiTool {
    Claude,
    Cursor,
    Windsurf,
    Cline,
    KiloCode,
    Antigravity,
    Hermes,
    OpenCode,
    Gemini,
    Codex,
    Copilot,
}

impl AiTool {
    pub fn label(self) -> &'static str {
        match self {
            AiTool::Claude => "Claude Code",
            AiTool::Cursor => "Cursor",
            AiTool::Windsurf => "Windsurf",
            AiTool::Cline => "Cline / Roo Code",
            AiTool::KiloCode => "Kilo Code",
            AiTool::Antigravity => "Google Antigravity",
            AiTool::Hermes => "Hermes CLI",
            AiTool::OpenCode => "OpenCode",
            AiTool::Gemini => "Gemini CLI",
            AiTool::Codex => "Codex (OpenAI)",
            AiTool::Copilot => "GitHub Copilot",
        }
    }

    pub fn cli_flags(self) -> Vec<String> {
        match self {
            AiTool::Claude => vec![],
            AiTool::Cursor => vec!["--agent".into(), "cursor".into()],
            AiTool::Windsurf => vec!["--agent".into(), "windsurf".into()],
            AiTool::Cline => vec!["--agent".into(), "cline".into()],
            AiTool::KiloCode => vec!["--agent".into(), "kilocode".into()],
            AiTool::Antigravity => vec!["--agent".into(), "antigravity".into()],
            AiTool::Hermes => vec!["--agent".into(), "hermes".into()],
            AiTool::OpenCode => vec!["--opencode".into()],
            AiTool::Gemini => vec!["--gemini".into()],
            AiTool::Codex => vec!["--codex".into()],
            AiTool::Copilot => vec!["--copilot".into()],
        }
    }
}

pub fn selectable_ai_tools() -> Vec<AiTool> {
    vec![
        AiTool::Claude,
        AiTool::Cursor,
        AiTool::Windsurf,
        AiTool::Cline,
        AiTool::KiloCode,
        AiTool::Antigravity,
        AiTool::Hermes,
        AiTool::OpenCode,
        AiTool::Gemini,
        AiTool::Codex,
        AiTool::Copilot,
    ]
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolSelection {
    pub action: Action,
    pub tool: ToolId,
    pub ai_tools: Vec<AiTool>,
}

impl Default for ToolSelection {
    fn default() -> Self {
        Self {
            action: Action::default(),
            tool: ToolId::Rtk,
            ai_tools: vec![AiTool::Claude],
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl CommandSpec {
    pub fn new<I, S>(program: impl Into<String>, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            program: program.into(),
            args: args.into_iter().map(Into::into).collect(),
        }
    }

    pub fn display(&self) -> String {
        if self.args.is_empty() {
            self.program.clone()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanStep {
    pub tool: ToolId,
    pub title: String,
    pub command: CommandSpec,
    pub touched_paths: Vec<String>,
    pub state: StepState,
    pub continue_on_failure: bool,
}

impl PlanStep {
    pub fn new(
        tool: ToolId,
        title: impl Into<String>,
        command: CommandSpec,
        touched_paths: Vec<String>,
    ) -> Self {
        Self {
            tool,
            title: title.into(),
            command,
            touched_paths,
            state: StepState::Pending,
            continue_on_failure: false,
        }
    }

    pub fn with_continue_on_failure(mut self) -> Self {
        self.continue_on_failure = true;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub steps: Vec<PlanStep>,
}

impl Plan {
    pub fn new(steps: Vec<PlanStep>) -> Self {
        Self { steps }
    }

    pub fn touched_paths(&self) -> Vec<&str> {
        let mut seen = HashSet::new();
        let mut ordered = Vec::new();

        for path in self.steps.iter().flat_map(|step| step.touched_paths.iter()) {
            if seen.insert(path.as_str()) {
                ordered.push(path.as_str());
            }
        }

        ordered
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StepState {
    Pending,
    Running,
    Succeeded,
    Skipped,
    Failed { code: Option<i32> },
}

impl StepState {
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            StepState::Succeeded | StepState::Skipped | StepState::Failed { .. }
        )
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ScanReport {
    pub brew_available: bool,
    pub cargo_available: bool,
    pub rtk_present: bool,
    pub rtk_version: Option<String>,
    pub rtk_gain_ok: bool,
    pub rtk_init_show_ok: bool,
    pub rtk_installed_ai_tools: Vec<AiTool>,
    pub node_major: Option<u32>,
    pub npx_available: bool,
    pub caveman_version: Option<String>,
    pub caveman_local_repo: Option<String>,
}

impl ScanReport {
    pub fn builder() -> ScanReportBuilder {
        ScanReportBuilder::default()
    }
}

#[derive(Clone, Debug, Default)]
pub struct ScanReportBuilder {
    report: ScanReport,
}

impl ScanReportBuilder {
    pub fn brew_available(mut self, value: bool) -> Self {
        self.report.brew_available = value;
        self
    }

    pub fn cargo_available(mut self, value: bool) -> Self {
        self.report.cargo_available = value;
        self
    }

    pub fn rtk_present(mut self, value: bool) -> Self {
        self.report.rtk_present = value;
        self
    }

    pub fn rtk_version(mut self, value: Option<&str>) -> Self {
        self.report.rtk_version = value.map(str::to_owned);
        self
    }

    pub fn rtk_gain_ok(mut self, value: bool) -> Self {
        self.report.rtk_gain_ok = value;
        self
    }

    pub fn rtk_init_show_ok(mut self, value: bool) -> Self {
        self.report.rtk_init_show_ok = value;
        self
    }

    pub fn rtk_installed_ai_tools(mut self, value: Vec<AiTool>) -> Self {
        self.report.rtk_installed_ai_tools = value;
        self
    }

    pub fn node_major(mut self, value: Option<u32>) -> Self {
        self.report.node_major = value;
        self
    }

    pub fn npx_available(mut self, value: bool) -> Self {
        self.report.npx_available = value;
        self
    }

    pub fn caveman_version(mut self, value: Option<&str>) -> Self {
        self.report.caveman_version = value.map(str::to_owned);
        self
    }

    pub fn caveman_local_repo(mut self, value: Option<&str>) -> Self {
        self.report.caveman_local_repo = value.map(str::to_owned);
        self
    }

    pub fn build(self) -> ScanReport {
        self.report
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StepOutput {
    pub command: String,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionResult {
    pub success: bool,
    pub steps: Vec<PlanStep>,
    pub outputs: Vec<StepOutput>,
}

impl ExecutionResult {
    pub fn failure_summary(&self) -> String {
        self.outputs
            .iter()
            .rev()
            .find(|output| output.code != 0)
            .map(|output| {
                if output.stderr.trim().is_empty() {
                    output.stdout.trim().to_owned()
                } else {
                    output.stderr.trim().to_owned()
                }
            })
            .unwrap_or_default()
    }
}
