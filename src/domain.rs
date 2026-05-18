use std::collections::HashSet;

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Recommended,
    Install,
    Uninstall,
    Upgrade,
    Repair,
    Verify,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExecutionMode {
    Apply,
    Preview,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolSelection {
    pub tools: Vec<ToolId>,
    pub action: Action,
    pub mode: ExecutionMode,
}

impl Default for ToolSelection {
    fn default() -> Self {
        Self {
            tools: vec![ToolId::Rtk, ToolId::Caveman],
            action: Action::Recommended,
            mode: ExecutionMode::Apply,
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
        }
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
    pub rtk_gain_ok: bool,
    pub rtk_init_show_ok: bool,
    pub node_major: Option<u32>,
    pub npx_available: bool,
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

    pub fn rtk_gain_ok(mut self, value: bool) -> Self {
        self.report.rtk_gain_ok = value;
        self
    }

    pub fn rtk_init_show_ok(mut self, value: bool) -> Self {
        self.report.rtk_init_show_ok = value;
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

    pub fn caveman_local_repo(mut self, value: Option<&str>) -> Self {
        self.report.caveman_local_repo = value.map(str::to_owned);
        self
    }

    pub fn build(self) -> ScanReport {
        self.report
    }
}
