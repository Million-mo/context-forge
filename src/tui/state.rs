use crate::domain::{Action, AiTool, ExecutionResult, Plan, ScanReport, ToolId, ToolSelection};
use crate::executor::execute_plan;
use crate::planner::build_plan;
use crate::runner::{CommandRunner, LiveTail};
use crate::scanner::scan_selected_tools;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppPage {
    PluginSelection,
    ActionSelection,
    AIToolSelection,
    Scanning,
    PlanSummary,
    Executing,
    Results,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KeyCommand {
    Enter,
    Back,
    NextTool,
    PreviousTool,
    ToggleTool,
    Quit,
}

#[derive(Clone)]
pub struct AppState {
    pub page: AppPage,
    pub selection: ToolSelection,
    pub highlighted_plugin_index: usize,
    pub highlighted_action_index: usize,
    pub highlighted_ai_tool_index: usize,
    pub should_quit: bool,
    pub scan_started: bool,
    pub scan: Option<ScanReport>,
    pub plan: Option<Plan>,
    pub execution_result: Option<ExecutionResult>,
    pub live_tail: LiveTail,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            page: AppPage::PluginSelection,
            selection: ToolSelection::default(),
            highlighted_plugin_index: 0,
            highlighted_action_index: 0,
            highlighted_ai_tool_index: 0,
            should_quit: false,
            scan_started: false,
            scan: None,
            plan: None,
            execution_result: None,
            live_tail: LiveTail::new(),
        }
    }

    pub fn handle(&mut self, command: KeyCommand) {
        match (self.page, command) {
            (_, KeyCommand::Quit) => {
                self.should_quit = true;
            }
            // PluginSelection: pick RTK or Caveman
            (AppPage::PluginSelection, KeyCommand::Enter) => {
                self.selection.tool = selectable_plugins()[self.highlighted_plugin_index];
                self.selection.action = Action::Install;
                self.page = AppPage::ActionSelection;
            }
            (AppPage::PluginSelection, KeyCommand::Back) => {
                self.should_quit = true;
            }
            (AppPage::PluginSelection, KeyCommand::NextTool) => {
                self.highlighted_plugin_index =
                    (self.highlighted_plugin_index + 1) % selectable_plugins().len();
            }
            (AppPage::PluginSelection, KeyCommand::PreviousTool) => {
                self.highlighted_plugin_index =
                    (self.highlighted_plugin_index + selectable_plugins().len() - 1)
                        % selectable_plugins().len();
            }
            // ActionSelection: pick Install/Uninstall/Upgrade for the chosen plugin
            (AppPage::ActionSelection, KeyCommand::Back) => {
                self.page = AppPage::PluginSelection;
            }
            (AppPage::ActionSelection, KeyCommand::NextTool) => {
                self.highlighted_action_index =
                    (self.highlighted_action_index + 1) % selectable_actions().len();
            }
            (AppPage::ActionSelection, KeyCommand::PreviousTool) => {
                self.highlighted_action_index =
                    (self.highlighted_action_index + selectable_actions().len() - 1)
                        % selectable_actions().len();
            }
            (AppPage::ActionSelection, KeyCommand::ToggleTool) => {
                self.selection.action = selectable_actions()[self.highlighted_action_index];
            }
            // AIToolSelection: multi-toggle AI tools
            (AppPage::AIToolSelection, KeyCommand::Back) => {
                self.page = AppPage::ActionSelection;
            }
            (AppPage::AIToolSelection, KeyCommand::NextTool) => {
                let tools = crate::domain::selectable_ai_tools();
                self.highlighted_ai_tool_index =
                    (self.highlighted_ai_tool_index + 1) % tools.len();
            }
            (AppPage::AIToolSelection, KeyCommand::PreviousTool) => {
                let tools = crate::domain::selectable_ai_tools();
                self.highlighted_ai_tool_index =
                    (self.highlighted_ai_tool_index + tools.len() - 1) % tools.len();
            }
            (AppPage::AIToolSelection, KeyCommand::ToggleTool) => {
                let tools = crate::domain::selectable_ai_tools();
                toggle_ai_tool(
                    &mut self.selection.ai_tools,
                    tools[self.highlighted_ai_tool_index],
                );
            }
            // PlanSummary: Enter triggers execution (handled in terminal.rs)
            (AppPage::PlanSummary, KeyCommand::Enter) => {
                self.page = AppPage::Executing;
            }
            (AppPage::PlanSummary, KeyCommand::Back) => {
                self.page = AppPage::ActionSelection;
            }
            // Results: back to PluginSelection for next operation
            (AppPage::Results, KeyCommand::Back) => {
                self.page = AppPage::PluginSelection;
            }
            _ => {}
        }
    }

    pub async fn scan_and_plan(&mut self, runner: &dyn CommandRunner) {
        self.page = AppPage::Scanning;
        self.scan_started = true;
        let scan = scan_selected_tools(runner, &[self.selection.tool]).await;
        let plan = build_plan(&self.selection, &scan);
        self.scan = Some(scan);
        self.plan = Some(plan);
        self.page = AppPage::PlanSummary;
    }

    pub async fn execute_current_plan(&mut self, runner: &dyn CommandRunner) {
        self.page = AppPage::Executing;
        if let Some(plan) = self.plan.clone() {
            let result = execute_plan(plan, runner).await;
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

pub fn selectable_actions() -> &'static [Action] {
    &[Action::Install, Action::Uninstall, Action::Upgrade]
}

impl Action {
    pub fn label(self) -> &'static str {
        match self {
            Action::Install => "Install",
            Action::Uninstall => "Uninstall",
            Action::Upgrade => "Upgrade",
        }
    }
}

pub fn selectable_plugins() -> &'static [ToolId] {
    &[ToolId::Rtk, ToolId::Caveman]
}

fn toggle_ai_tool(selected: &mut Vec<AiTool>, tool: AiTool) {
    if let Some(index) = selected.iter().position(|t| *t == tool) {
        selected.remove(index);
        return;
    }

    selected.push(tool);
    selected.sort();
}
