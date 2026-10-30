import { idSchema, loadConfig } from '@platform/contracts';
import { createPool, RunRepository } from '@platform/persistence';
import { requirePositional, type ParsedArgs } from '../args.js';
import { CliError, type CliContext } from '../context.js';

/** Stage name used by each role in the mock research workflow. */
const STAGE_BY_ROLE: Record<string, string> = {
  researcher: 'research',
  'business-owner': 'evaluation',
};

async function withRepository<T>(
  ctx: CliContext,
  action: (repo: RunRepository) => Promise<T>,
): Promise<T> {
  const db = createPool(loadConfig(ctx.env).DATABASE_URL);
  try {
    return await action(new RunRepository(db));
  } finally {
    await db.end();
  }
}

export async function executionsCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const runId = idSchema.parse(requirePositional(args, 0, 'runId'));
  await withRepository(ctx, async (repo) => {
    for (const execution of await repo.listExecutions(runId)) {
      const reason = execution.uncertainReason ? ` reason="${execution.uncertainReason}"` : '';
      ctx.out(
        `${execution.executionId}  state=${execution.state} attempts=${execution.attempts} cost=${execution.costUsd ?? 'n/a'}${reason}`,
      );
    }
  });
}

/** Operator step for an `uncertain` execution; requires an explicit confirmation flag. */
export async function reconcileCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const runId = idSchema.parse(requirePositional(args, 0, 'runId'));
  const role = requirePositional(args, 1, 'role');
  if (args.flags['confirm-no-external-run'] === undefined) {
    throw new CliError(
      'pass --confirm-no-external-run only after verifying out-of-band that no paid run happened (or accepting a re-run)',
    );
  }
  const stage = STAGE_BY_ROLE[role];
  if (!stage) {
    throw new CliError('role must be researcher or business-owner');
  }
  const executionId = `${runId}:${role}:${stage}`;
  await withRepository(ctx, async (repo) => {
    const wasReset = await repo.resetUncertain(executionId);
    ctx.out(
      wasReset
        ? `reset ${executionId}; start the run again with the same --run-id`
        : `${executionId} is not uncertain`,
    );
  });
}
