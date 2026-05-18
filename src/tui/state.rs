use crate::domain::{Action, ExecutionMode, ExecutionResult, Plan, ScanReport, ToolSelection};
use crate::executor::execute_plan;
use crate::planner::build_plan;
use crate::runner::CommandRunner;
use crate::scanner::scan_selected_tools;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPage {
    ToolSelection,
    Scanning,
    PlanSummary,
    Executing,
    Results,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyCommand {
    Enter,
    Preview,
    Expand,
    Back,
    NextAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppState {
    pub page: AppPage,
    pub selection: ToolSelection,
    pub scan_started: bool,
    pub details_expanded: bool,
    pub scan: Option<ScanReport>,
    pub plan: Option<Plan>,
    pub execution_result: Option<ExecutionResult>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            page: AppPage::ToolSelection,
            selection: ToolSelection::default(),
            scan_started: false,
            details_expanded: false,
            scan: None,
            plan: None,
            execution_result: None,
        }
    }

    pub fn handle(&mut self, command: KeyCommand) {
        match (self.page, command) {
            (AppPage::ToolSelection, KeyCommand::Enter) => {
                self.page = AppPage::Scanning;
                self.scan_started = true;
            }
            (AppPage::PlanSummary, KeyCommand::Enter) => {
                self.page = AppPage::Executing;
            }
            (AppPage::PlanSummary, KeyCommand::Preview) => {
                self.selection.mode = ExecutionMode::Preview;
            }
            (AppPage::PlanSummary, KeyCommand::Expand) => {
                self.details_expanded = !self.details_expanded;
            }
            (AppPage::PlanSummary, KeyCommand::Back) => {
                self.page = AppPage::ToolSelection;
            }
            (_, KeyCommand::NextAction) => {
                self.selection.action = next_action(self.selection.action);
            }
            _ => {}
        }
    }

    pub async fn scan_and_plan(&mut self, runner: &dyn CommandRunner) {
        self.page = AppPage::Scanning;
        self.scan_started = true;
        let scan = scan_selected_tools(runner, &self.selection.tools).await;
        let plan = build_plan(&self.selection, &scan);
        self.scan = Some(scan);
        self.plan = Some(plan);
        self.page = AppPage::PlanSummary;
    }

    pub async fn execute_current_plan(&mut self, runner: &dyn CommandRunner) {
        self.page = AppPage::Executing;
        if let Some(plan) = self.plan.clone() {
            let result = execute_plan(plan, self.selection.mode, runner).await;
            self.execution_result = Some(result);
        }
        self.page = AppPage::Results;
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

fn next_action(action: Action) -> Action {
    match action {
        Action::Recommended => Action::Install,
        Action::Install => Action::Uninstall,
        Action::Uninstall => Action::Upgrade,
        Action::Upgrade => Action::Repair,
        Action::Repair => Action::Verify,
        Action::Verify => Action::Recommended,
    }
}
