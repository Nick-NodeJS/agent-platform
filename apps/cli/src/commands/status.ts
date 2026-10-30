import { STATUS_QUERY, idSchema, loadConfig, workflowStatusSchema } from '@platform/contracts';
import { LocalTaskStore } from '@platform/integrations';
import { createPool, RunRepository } from '@platform/persistence';
import { requirePositional, type ParsedArgs } from '../args.js';
import { openTemporal, temporalUiUrl, type CliContext } from '../context.js';

export async function statusCommand(ctx: CliContext, args: ParsedArgs): Promise<void> {
  const runId = idSchema.parse(requirePositional(args, 0, 'runId'));
  const config = loadConfig(ctx.env);
  const temporal = await openTemporal(ctx);
  let workflowState: string;
  let status;
  try {
    const handle = temporal.client.workflow.getHandle(runId);
    workflowState = (await handle.describe()).status.name;
    status = workflowStatusSchema.parse(await handle.query(STATUS_QUERY));
  } finally {
    await temporal.connection.close();
  }

  ctx.out(`run:       ${runId}`);
  ctx.out(`workflow:  ${workflowState}`);
  ctx.out(`status:    ${status.status}`);
  ctx.out('stages:');
  for (const stage of status.stages) {
    ctx.out(`  ${stage.at}  ${stage.stage}`);
  }
  if (status.taskId) {
    const tasks = new LocalTaskStore({ rootDir: config.TASK_STORE_DIR });
    ctx.out(`task:      ${status.taskId}`);
    ctx.out(`task file: ${tasks.locate(status.taskId)}`);
    for (const result of await tasks.getResults(status.taskId)) {
      ctx.out(`result:    ${result.kind} (${result.producedBy}) ${JSON.stringify(result.payload)}`);
    }
  }
  if (status.gate) {
    const artifacts = status.gate.artifacts.map((artifact) => artifact.resultId).join(', ');
    ctx.out(`gate:      ${status.gate.gateId} (artifacts: ${artifacts})`);
  }
  if (status.decision) {
    const { decision, actor, keyId } = status.decision;
    ctx.out(`decision:  ${decision} by ${actor} (signer ${keyId}, human-controlled signer)`);
  }

  const db = createPool(config.DATABASE_URL);
  try {
    const summary = await new RunRepository(db).getRunSummary(runId);
    ctx.out(
      summary
        ? `postgres:  status=${summary.run.status} results=${summary.results.length} approvals=${summary.approvals.length} costUsd=${summary.totalCostUsd}`
        : 'postgres:  no run record yet',
    );
  } finally {
    await db.end();
  }
  ctx.out(`temporal UI: ${temporalUiUrl(config.TEMPORAL_NAMESPACE, runId)}`);
}
