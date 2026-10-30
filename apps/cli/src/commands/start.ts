import { randomUUID } from 'node:crypto';
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import {
  WORKFLOW_NAME,
  idSchema,
  resourceConstraintsSchema,
  type ResearchProposalInput,
} from '@platform/contracts';
import { optionalNumber, type ParsedArgs } from '../args.js';
import { CliError, openTemporal, temporalUiUrl, type CliContext } from '../context.js';

const RUN_ID_RANDOM_CHARS = 12;

export async function startCommand(ctx: CliContext, { flags }: ParsedArgs): Promise<void> {
  const goal = flags['goal'];
  if (!goal) {
    throw new CliError('--goal is required');
  }
  const runId = idSchema.parse(
    flags['run-id'] ?? `run-${randomUUID().slice(0, RUN_ID_RANDOM_CHARS)}`,
  );
  // Constraints that are not supplied stay 'unknown' (the schema default); they are never guessed.
  const constraints = resourceConstraintsSchema.parse({
    budgetUsd: optionalNumber(flags['budget-usd'], 'budget-usd'),
    teamSize: optionalNumber(flags['team-size'], 'team-size'),
    timelineWeeks: optionalNumber(flags['timeline-weeks'], 'timeline-weeks'),
    notes: flags['notes'],
  });
  const { client, config, connection } = await openTemporal(ctx);
  try {
    const input: ResearchProposalInput = { runId, goal, constraints };
    await client.workflow.start(WORKFLOW_NAME, {
      workflowId: runId,
      taskQueue: config.TASK_QUEUE,
      args: [input],
      // One logical run id has one immutable human decision: only a FAILED (undecided) execution may be restarted with
      // the same id. Running and completed ones are refused; the conflict policy never terminates or reuses them.
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
    });
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      throw new CliError(
        `run ${runId} already exists and is running or completed; it was not restarted. ` +
          `Inspect it with "pnpm cli status ${runId}", or choose a new --run-id for a new request.`,
      );
    }
    throw error;
  } finally {
    await connection.close();
  }
  ctx.out(`started run ${runId}`);
  ctx.out(`status:  pnpm cli status ${runId}`);
  ctx.out(`temporal UI: ${temporalUiUrl(config.TEMPORAL_NAMESPACE, runId)}`);
}
