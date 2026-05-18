use crate::domain::{Plan, ScanReport, ToolId, ToolSelection};
use crate::tools::{caveman, rtk};

pub fn build_plan(selection: &ToolSelection, scan: &ScanReport) -> Plan {
    let mut steps = Vec::new();

    for tool in &selection.tools {
        match tool {
            ToolId::Rtk => steps.extend(rtk::plan(selection.action, scan)),
            ToolId::Caveman => steps.extend(caveman::plan(selection.action, scan)),
        }
    }

    Plan::new(steps)
}
