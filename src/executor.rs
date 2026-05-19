use crate::domain::{ExecutionResult, Plan, StepOutput, StepState};
use crate::runner::CommandRunner;

pub async fn execute_plan(mut plan: Plan, runner: &dyn CommandRunner) -> ExecutionResult {
    let mut outputs = Vec::new();
    let mut success = true;

    for step in &mut plan.steps {
        step.state = StepState::Running;
        let output = runner.run(&step.command).await;
        outputs.push(StepOutput {
            command: step.command.display(),
            code: output.code,
            stdout: output.stdout.clone(),
            stderr: output.stderr.clone(),
        });

        if output.succeeded() {
            step.state = StepState::Succeeded;
        } else {
            step.state = StepState::Failed {
                code: Some(output.code),
            };
            if !step.continue_on_failure {
                success = false;
                break;
            }
        }
    }

    ExecutionResult {
        success,
        steps: plan.steps,
        outputs,
    }
}
