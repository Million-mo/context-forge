use crate::domain::{CommandSpec, ScanReport, ToolId};
use crate::runner::CommandRunner;

pub async fn scan_selected_tools(runner: &dyn CommandRunner, tools: &[ToolId]) -> ScanReport {
    let mut builder = ScanReport::builder();

    if tools.contains(&ToolId::Rtk) {
        let rtk_present = run_ok(runner, CommandSpec::new("which", ["rtk"])).await;
        let rtk_gain_ok = rtk_present && run_ok(runner, CommandSpec::new("rtk", ["gain"])).await;
        let rtk_init_show_ok =
            rtk_present && run_ok(runner, CommandSpec::new("rtk", ["init", "--show"])).await;
        let brew_available = run_ok(runner, CommandSpec::new("which", ["brew"])).await;
        let cargo_available = run_ok(runner, CommandSpec::new("which", ["cargo"])).await;

        builder = builder
            .rtk_present(rtk_present)
            .rtk_gain_ok(rtk_gain_ok)
            .rtk_init_show_ok(rtk_init_show_ok)
            .brew_available(brew_available)
            .cargo_available(cargo_available);
    }

    if tools.contains(&ToolId::Caveman) {
        let node_output = runner.run(&CommandSpec::new("node", ["--version"])).await;
        let node_major = if node_output.succeeded() {
            parse_node_major(&node_output.stdout)
        } else {
            None
        };
        let npx_available = run_ok(runner, CommandSpec::new("which", ["npx"])).await;

        builder = builder.node_major(node_major).npx_available(npx_available);
    }

    builder.build()
}

async fn run_ok(runner: &dyn CommandRunner, command: CommandSpec) -> bool {
    runner.run(&command).await.succeeded()
}

fn parse_node_major(stdout: &str) -> Option<u32> {
    stdout
        .trim()
        .strip_prefix('v')
        .unwrap_or_else(|| stdout.trim())
        .split('.')
        .next()
        .and_then(|major| major.parse().ok())
}
