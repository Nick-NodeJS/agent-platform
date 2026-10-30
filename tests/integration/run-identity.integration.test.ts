import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { runCli } from '../../apps/cli/src/cli.js';
import {
  createActivities,
  DECISION_CONFLICT,
  RUN_ALREADY_DECIDED,
} from '../../apps/worker/src/activities.js';
import { MockAgentExecutor } from '@platform/integrations';
import { workflowStatusSchema, type TaskStore } from '@platform/contracts';
import { digestPayload } from '@platform/contracts/node';
import {
  CountingExecutor,
  approvalRows,
  cliContext,
  constraints,
  createEnv,
  newRunId,
  query,
  readTaskFile,
  resultIds,
  sign,
  signForGate,
  startRun,
  startRunBypassingCli,
  startWorker,
  submit,
  terminateQuietly,
  waitForGate,
  type Env,
  type RunningWorker,
} from './harness.js';

const WAITING = 'WAITING_FOR_HUMAN_APPROVAL';

describe('one logical run id has one immutable human decision (live Temporal + Postgres)', () => {
  let env: Env;
  let worker: RunningWorker;
  let executor: CountingExecutor;
  const startedRuns: string[] = [];

  beforeAll(async () => {
    env = await createEnv();
    executor = new CountingExecutor();
    worker = await startWorker(env, { executor });
  });

  afterAll(async () => {
    for (const runId of startedRuns) {
      await terminateQuietly(env, runId);
    }
    await worker?.stop();
    await env?.cleanup();
  });

  const startTracked = async (runId = newRunId('id')) => {
    startedRuns.push(await startRun(env, runId));
    return runId;
  };

  const cliStart = async (runId: string) => {
    const { ctx, out, err } = cliContext(env);
    const code = await runCli(['start', '--goal', 'restart attempt', '--run-id', runId], ctx);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  /** Everything observable about a run that a rejected restart must leave untouched. */
  const snapshot = async (runId: string) => {
    const handle = env.client.workflow.getHandle(runId);
    const description = await handle.describe();
    const run = await env.db.query('SELECT status FROM runs WHERE run_id=$1', [runId]);
    const executions = await env.db.query(
      'SELECT role, state, attempts FROM agent_executions WHERE run_id=$1 ORDER BY role',
      [runId],
    );
    const results = await env.db.query(
      'SELECT result_id, digest FROM results WHERE run_id=$1 ORDER BY result_id',
      [runId],
    );
    return {
      executionRunId: description.runId,
      historyLength: description.historyLength,
      run: run.rows,
      executions: executions.rows,
      results: results.rows,
      approvals: await approvalRows(env, runId),
      taskFile: await readFile(path.join(env.tasksDir, `task-${runId}.json`), 'utf8'),
      executorCalls: executor.count(),
    };
  };

  /** Workflow output, Postgres and the task JSON must all describe the same decision and signer. */
  const expectConsistentDecision = async (
    runId: string,
    decision: 'approve' | 'reject',
    executionRunId?: string,
  ) => {
    const finalStatus = decision === 'approve' ? 'APPROVED' : 'REJECTED';
    const output = workflowStatusSchema.parse(
      await env.client.workflow.getHandle(runId, executionRunId).result(),
    );
    const rows = await approvalRows(env, runId);
    const run = await env.db.query('SELECT status FROM runs WHERE run_id=$1', [runId]);
    const taskFile = await readTaskFile(env, runId);

    expect(output.status).toBe(finalStatus);
    expect(run.rows).toEqual([{ status: finalStatus }]);
    expect(taskFile.task.status).toBe(finalStatus);
    expect(rows).toHaveLength(1);
    expect(taskFile.approvals).toHaveLength(1);
    const [row] = rows;
    expect(output.decision).toEqual({
      decision,
      source: 'human',
      actor: row?.actor,
      keyId: row?.key_id,
      decisionId: row?.decision_id,
    });
    expect(taskFile.approvals[0]).toMatchObject({
      decision,
      source: 'human',
      actor: row?.actor,
      keyId: row?.key_id,
      decisionId: row?.decision_id,
    });
  };

  const finish = async (runId: string, decision: 'approve' | 'reject') => {
    const status = await waitForGate(env, runId);
    await submit(env, runId, sign(env, status, { decision }));
    await env.client.workflow.getHandle(runId).result();
  };

  const rootCauseType = async (handle: { result: () => Promise<unknown> }) => {
    const outcome = await handle.result().then(
      () => undefined,
      (error: unknown) => error,
    );
    if (!(outcome instanceof WorkflowFailedError)) {
      throw new Error('expected the workflow to fail');
    }
    let cause: Error = outcome;
    while (cause.cause instanceof Error) {
      cause = cause.cause;
    }
    return cause instanceof ApplicationFailure ? cause.type : undefined;
  };

  it.each(['approve', 'reject'] as const)(
    'a %s-ed run cannot be restarted through the CLI: history, decision, task and executions stay unchanged',
    async (decision) => {
      const runId = await startTracked();
      await finish(runId, decision);
      await expectConsistentDecision(runId, decision);
      const before = await snapshot(runId);

      const restart = await cliStart(runId);

      expect(restart.code).toBe(1);
      expect(restart.err).toContain('already exists');
      expect(restart.err).toContain('new --run-id');
      expect(await snapshot(runId)).toEqual(before);
      await expectConsistentDecision(runId, decision);
    },
  );

  it('starting a run id that is still active is refused and creates no second execution', async () => {
    const runId = await startTracked();
    await waitForGate(env, runId);
    const before = await snapshot(runId);

    const restart = await cliStart(runId);

    expect(restart.code).toBe(1);
    expect(restart.err).toContain('already exists');
    expect(await snapshot(runId)).toEqual(before);
    expect((await query(env, runId)).status).toBe(WAITING);
    await finish(runId, 'approve');
  });

  it('bypassing the CLI with a permissive reuse policy still cannot re-decide a decided run id', async () => {
    const runId = await startTracked();
    await finish(runId, 'approve');
    const before = await snapshot(runId);
    const decidedExecution = before.executionRunId;

    const second = await startRunBypassingCli(env, runId);

    expect(await rootCauseType(second)).toBe(RUN_ALREADY_DECIDED);
    const after = await snapshot(runId);
    // The new (failed) execution is the only difference: stored decision, results, task files and agent calls are untouched.
    expect({ ...after, executionRunId: undefined, historyLength: undefined }).toEqual({
      ...before,
      executionRunId: undefined,
      historyLength: undefined,
    });
    expect(after.executorCalls).toBe(before.executorCalls);
    await expectConsistentDecision(runId, 'approve', decidedExecution);
  });

  it('Postgres alone protects a decided run id when no Temporal history exists for it', async () => {
    const decidedId = newRunId('dbonly');
    const timestamp = new Date().toISOString();
    await env.repo.insertRun({
      runId: decidedId,
      workflowId: decidedId,
      taskId: `task-${decidedId}`,
      goal: 'g',
      constraints,
      status: 'CREATED',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const gate = await env.repo.openGate({
      gateId: `gate-${decidedId}`.slice(0, 60),
      runId: decidedId,
      artifacts: [{ resultId: 'x', digest: 'a'.repeat(64) }],
    });
    const envelope = signForGate(gate, { decision: 'reject' }, env.signer);
    await env.repo.recordDecision({
      approval: {
        approvalId: `${decidedId}-final-decision`,
        taskId: `task-${decidedId}`,
        runId: decidedId,
        decision: 'reject',
        source: 'human',
        actor: env.signer.actor,
        decisionId: envelope.payload.decisionId,
        keyId: env.signer.keyId,
        envelopeDigest: digestPayload(envelope),
        createdAt: timestamp,
      },
      envelope,
      gateId: gate.gateId,
    });
    const terminalId = newRunId('dbonly');
    await env.repo.insertRun({
      runId: terminalId,
      workflowId: terminalId,
      taskId: `task-${terminalId}`,
      goal: 'g',
      constraints,
      status: 'REJECTED',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const callsBefore = executor.count();

    for (const runId of [decidedId, terminalId]) {
      startedRuns.push(await startRun(env, runId));
      expect(await rootCauseType(env.client.workflow.getHandle(runId))).toBe(RUN_ALREADY_DECIDED);
      await expect(readTaskFile(env, runId)).rejects.toThrow(); // no task or projection was created
    }
    expect(executor.count()).toBe(callsBefore);
    expect((await env.repo.getDecisionState(decidedId))?.hasDecision).toBe(true);
    expect(await resultIds(env, decidedId)).toEqual([]);
  });

  it('a failed, undecided run can restart with the same id and reuses its stored stages', async () => {
    const runId = await startTracked();
    await waitForGate(env, runId);
    await terminateQuietly(env, runId); // undecided and no longer running: eligible for recovery
    const callsBefore = executor.count();

    startedRuns.push(await startRun(env, runId));
    await finish(runId, 'approve');

    expect(executor.count()).toBe(callsBefore);
    await expectConsistentDecision(runId, 'approve');
  });

  it('a retry after the decision was stored but before projection reuses the exact stored approval and repairs the task file', async () => {
    await worker.stop();
    let projectionFailuresLeft = 1;
    let recordDecisionCalls = 0;
    const flakyTasks: TaskStore = {
      createTask: (task) => env.tasks.createTask(task),
      getTask: (taskId) => env.tasks.getTask(taskId),
      changeStatus: (taskId, status) => env.tasks.changeStatus(taskId, status),
      attachResult: (taskId, result) => env.tasks.attachResult(taskId, result),
      getResults: (taskId) => env.tasks.getResults(taskId),
      getApprovals: (taskId) => env.tasks.getApprovals(taskId),
      locate: (taskId) => env.tasks.locate(taskId),
      recordApproval: async (taskId, approval) => {
        if (projectionFailuresLeft-- > 0) {
          throw new Error('injected: projection failed after the decision was stored');
        }
        return env.tasks.recordApproval(taskId, approval);
      },
    };
    worker = await startWorker(env, { executor, tasks: flakyTasks }, (activities) => ({
      ...activities,
      recordDecision: async (args) => {
        recordDecisionCalls++;
        return activities.recordDecision(args);
      },
    }));

    const runId = await startTracked();
    await finish(runId, 'reject');

    expect(recordDecisionCalls).toBeGreaterThanOrEqual(2);
    expect(await approvalRows(env, runId)).toHaveLength(1);
    await expectConsistentDecision(runId, 'reject');
    await worker.stop();
    worker = await startWorker(env, { executor });
  });

  it('a conflicting decision for an already decided run fails the Activity as a non-retryable DecisionConflict and changes nothing', async () => {
    const runId = await startTracked();
    await finish(runId, 'approve');
    const status = await query(env, runId);
    const before = await snapshot(runId);
    const activities = createActivities({
      repo: env.repo,
      tasks: env.tasks,
      executor: new MockAgentExecutor(),
      trustedSignersFile: env.trustedFile,
    });
    const gate = status.gate;
    if (!gate) {
      throw new Error('a finished run keeps its gate in the status');
    }

    const conflicting = signForGate(gate, { decision: 'reject' }, env.signer);
    const outcome = await activities
      .recordDecision({
        runId,
        taskId: `task-${runId}`,
        gate,
        envelope: conflicting,
        verifiedAt: new Date().toISOString(),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(outcome).toBeInstanceOf(ApplicationFailure);
    expect(outcome).toMatchObject({ type: DECISION_CONFLICT, nonRetryable: true });
    expect(await snapshot(runId)).toEqual(before);
    await expectConsistentDecision(runId, 'approve');
  });

  it('a recorded history replays against the current workflow code (replay safety guard)', async () => {
    const runId = await startTracked();
    await finish(runId, 'approve');
    const history = await env.client.workflow.getHandle(runId).fetchHistory();

    await expect(
      Worker.runReplayHistory({ workflowBundle: env.bundle }, history, runId),
    ).resolves.toBeUndefined();
  });
});
