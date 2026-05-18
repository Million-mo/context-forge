use crate::domain::{Action, ExecutionMode, ToolSelection};

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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            page: AppPage::ToolSelection,
            selection: ToolSelection::default(),
            scan_started: false,
            details_expanded: false,
        }
    }

    pub fn handle(&mut self, command: KeyCommand) {
        match (self.page, command) {
            (AppPage::ToolSelection, KeyCommand::Enter) => {
                self.page = AppPage::Scanning;
                self.scan_started = true;
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
