use crate::domain::{Action, Plan, ScanReport, ToolId, ToolSelection};
use crate::tools::{caveman, rtk};

pub fn build_plan(selection: &ToolSelection, scan: &ScanReport) -> Plan {
    let steps = match selection.action {
        Action::Install => match selection.tool {
            ToolId::Rtk => rtk::install_plan(scan, &selection.ai_tools),
            ToolId::Caveman => caveman::install_plan(scan),
        },
        Action::Uninstall => match selection.tool {
            ToolId::Rtk => rtk::uninstall_plan(scan, &selection.ai_tools),
            ToolId::Caveman => caveman::uninstall_plan(scan, &selection.ai_tools),
        },
        Action::Upgrade => match selection.tool {
            ToolId::Rtk => rtk::upgrade_plan(scan, &selection.ai_tools),
            ToolId::Caveman => caveman::upgrade_plan(scan),
        },
    };

    Plan::new(steps)
}
