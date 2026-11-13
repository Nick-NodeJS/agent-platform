import { randomUUID } from 'node:crypto';
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import { WORKFLOW_NAME, idSchema, type ResearchProposalInput } from '@platform/contracts';
import { loadPlatformConstraints } from '@platform/contracts/node';
import { resolveRepositoryPath } from '@platform/integrations';
import { optionalNumber, type ParsedArgs } from '../args.js';
import { CliError, openTemporal, temporalUiUrl, type CliContext } from '../context.js';

const RUN_ID_RANDOM_CHARS = 12;

const DEFAULT_CONSTRAINTS_FILE = 'config/platform-constraints.json';

const STARTUP_FLAGS = new Set([
  'goal',
  'run-id',
  'constraints-file',
  'build-budget-usd',
  'monthly-run-cap-usd',
  'launch-deadline-weeks',
  'notes',
]);

/** Flags from earlier versions get a pointer instead of being silently ignored. */
const RENAMED_FLAGS: Record<string, string> = {
  'budget-usd': 'use --build-budget-usd',
  'timeline-weeks': 'use --launch-deadline-weeks',
  'team-size': 'it was removed (the team is the agent roles; you only approve)',
};

function rejectUnknownFlags(flags: Record<string, string>): void {
  for (const name of Object.keys(flags)) {
    if (!STARTUP_FLAGS.has(name)) {
      throw new CliError(
        `unknown option --${name}${RENAMED_FLAGS[name] ? `: ${RENAMED_FLAGS[name]}` : ''}`,
      );
    }
  }
}

export async function startCommand(ctx: CliContext, { flags }: ParsedArgs): Promise<void> {
  rejectUnknownFlags(flags);
  const goal = flags['goal'];
  if (!goal) {
    throw new CliError('--goal is required');
  }
  const runId = idSchema.parse(
    flags['run-id'] ?? `run-${randomUUID().slice(0, RUN_ID_RANDOM_CHARS)}`,
  );
  // The constraints file supplies the limits; flags override single values. Unset values stay 'unknown', never guessed.
  const constraintsFile = resolveRepositoryPath(
    flags['constraints-file'] ?? DEFAULT_CONSTRAINTS_FILE,
  );
  let constraints;
  try {
    constraints = loadPlatformConstraints(constraintsFile, {
      buildBudgetUsd: optionalNumber(flags['build-budget-usd'], 'build-budget-usd'),
      monthlyRunCapUsd: optionalNumber(flags['monthly-run-cap-usd'], 'monthly-run-cap-usd'),
      launchDeadlineWeeks: optionalNumber(flags['launch-deadline-weeks'], 'launch-deadline-weeks'),
      notes: flags['notes'],
    });
  } catch (error) {
    throw new CliError(
      `cannot use constraints file ${constraintsFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
