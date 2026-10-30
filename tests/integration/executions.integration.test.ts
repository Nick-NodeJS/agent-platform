import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import {
  ExecutorNotStartedError,
  researchProposalSchema,
  taskSchema,
  type Result,
  type TaskStore,
} from '@platform/contracts';
import { digestPayload } from '@platform/contracts/node';
import { RunRepository, StaleExecutionError } from '@platform/persistence';
import { executionIdFor, runAgentStage } from '../../apps/worker/src/agent-stage.js';
import {
  CountingExecutor,
  constraints,
  createEnv,
  newRunId,
  readTaskFile,
  resultIds,
  startRun,
  startWorker,
  terminateQuietly,
  waitForGate,
  type Env,
  type RunningWorker,
} from './harness.js';

const SHORT_LEASE_MS = 1000;
const LEASE_EXPIRY_WAIT_MS = SHORT_LEASE_MS + 300;
const SLOW_EXECUTOR_MS = 700;
const CONCURRENT_ATTEMPTS = 5;
const PERSIST_FAILS_FOREVER = 1000;
const FAST_PERSIST_ATTEMPTS = 2;

/** Repository that can fail specific steps to model a crash at that exact point. */
class FaultyRepo extends RunRepository {
  failCompleteTimes = 0;
  /** Thrown (once) instead of recording the invocation, e.g. a stale-ownership error. */
  markInvokedFailure: Error | undefined;
  /** Thrown on every completion attempt while set. */
  completeFailure: Error | undefined;

  override async completeExecution(...args: Parameters<RunRepository['completeExecution']>) {
    if (this.completeFailure) {
      throw this.completeFailure;
    }
    if (this.failCompleteTimes > 0) {
      this.failCompleteTimes--;
      throw new Error('injected: database unavailable while persisting result');
    }
    return super.completeExecution(...args);
  }

  override async markInvoked(...args: Parameters<RunRepository['markInvoked']>) {
    const failure = this.markInvokedFailure;
    if (failure) {
      this.markInvokedFailure = undefined;
      throw failure;
    }
    return super.markInvoked(...args);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FailureCause {
  message: string;
  type: string | undefined;
}

describe('durable agent executions and Activity retries (live Temporal + Postgres)', () => {
  let env: Env;
  let repo: FaultyRepo;
  let worker: RunningWorker | undefined;
  const startedRuns: string[] = [];

  const startTrackedRun = async (runId?: string) => {
    const id = await startRun(env, runId);
    startedRuns.push(id);
    return id;
  };

  const stopWorker = async () => {
    await worker?.stop();
    worker = undefined;
  };

  const execution = async (runId: string, role: string, stage: string) => {
    const record = await repo.getExecution(executionIdFor(runId, role, stage));
    if (!record) {
      throw new Error(`no execution for ${runId}/${role}/${stage}`);
    }
    return record;
  };

  /** Root cause of a failed workflow (the innermost failure carries the Activity's error type). */
  const rootCause = async (runId: string): Promise<FailureCause> => {
    const outcome = await env.client.workflow
      .getHandle(runId)
      .result()
      .then(
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
    return {
      message: cause.message,
      type: cause instanceof ApplicationFailure ? (cause.type ?? undefined) : undefined,
    };
  };

  const stageDeps = (executor: CountingExecutor, tasks: TaskStore = env.tasks) => ({
    repo,
    tasks,
    executor,
    leaseTtlMs: 5000,
  });

  const researchStage = (runId: string) => ({
    runId,
    taskId: `task-${runId}`,
    role: 'researcher' as const,
    stage: 'research',
    kind: 'research-proposal' as const,
    resultId: `${runId}-research-proposal`,
    input: { goal: 'g', constraints },
    validateOutput: (output: unknown) => researchProposalSchema.parse(output),
  });

  /** A run + task that exist without any workflow, for tests that call the stage runner directly. */
  const seedRun = async (runId: string) => {
    const timestamp = new Date().toISOString();
    await repo.insertRun({
      runId,
      workflowId: runId,
      taskId: `task-${runId}`,
      goal: 'g',
      constraints,
      status: 'CREATED',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await env.tasks.createTask({
      taskId: `task-${runId}`,
      runId,
      title: 't',
      description: 'd',
      status: 'CREATED',
      resultIds: [],
      approvalIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };

  const seededRun = async (prefix: string) => {
    const runId = newRunId(prefix);
    await seedRun(runId);
    return runId;
  };

  beforeAll(async () => {
    env = await createEnv();
    repo = new FaultyRepo(env.db);
  });

  afterAll(async () => {
    for (const runId of startedRuns) {
      await terminateQuietly(env, runId);
    }
    await stopWorker();
    await env?.cleanup();
  });

  it('failure after canonical persistence but before task projection: the Activity retry reuses the stored result', async () => {
    const executor = new CountingExecutor();
    let projectionFailuresLeft = 1;
    const flakyTasks: TaskStore = {
      createTask: (task) => env.tasks.createTask(task),
      getTask: (taskId) => env.tasks.getTask(taskId),
      changeStatus: (taskId, status) => env.tasks.changeStatus(taskId, status),
      recordApproval: (taskId, approval) => env.tasks.recordApproval(taskId, approval),
      getResults: (taskId) => env.tasks.getResults(taskId),
      getApprovals: (taskId) => env.tasks.getApprovals(taskId),
      locate: (taskId) => env.tasks.locate(taskId),
      attachResult: async (taskId, result) => {
        if (projectionFailuresLeft-- > 0) {
          throw new Error('injected: task projection failed');
        }
        return env.tasks.attachResult(taskId, result);
      },
    };
    worker = await startWorker(env, { executor, tasks: flakyTasks, repo });
    const runId = await startTrackedRun();
    await waitForGate(env, runId);

    expect(executor.count('researcher')).toBe(1);
    expect(executor.count('business-owner')).toBe(1);
    const record = await execution(runId, 'researcher', 'research');
    expect(record.state).toBe('succeeded');
    expect(record.attempts).toBe(1);
    const stored = await readTaskFile(env, runId);
    expect(stored.results.map((result) => result.kind).sort()).toEqual([
      'business-evaluation',
      'research-proposal',
    ]);
    const costs = await env.db.query(
      'SELECT count(*)::int AS n FROM cost_entries WHERE run_id=$1',
      [runId],
    );
    expect(costs.rows).toEqual([{ n: 2 }]);
    await stopWorker();
  });

  it('failure after the whole Activity body completed: the Activity retry is a pure reuse', async () => {
    const executor = new CountingExecutor();
    let crashesLeft = 1;
    worker = await startWorker(env, { executor, repo }, (activities) => ({
      ...activities,
      runResearcher: async (args) => {
        const outcome = await activities.runResearcher(args);
        if (crashesLeft-- > 0) {
          throw new Error('injected: worker died right after the Activity finished');
        }
        return outcome;
      },
    }));
    const runId = await startTrackedRun();
    await waitForGate(env, runId);
    expect(executor.count('researcher')).toBe(1);
    expect((await execution(runId, 'researcher', 'research')).attempts).toBe(1);
    await stopWorker();
  });

  it('a transient persistence failure after the executor finished is retried in-attempt without a second execution', async () => {
    const executor = new CountingExecutor();
    repo.failCompleteTimes = 1;
    worker = await startWorker(env, { executor, repo });
    const runId = await startTrackedRun();
    await waitForGate(env, runId);
    expect(executor.count('researcher')).toBe(1);
    expect((await execution(runId, 'researcher', 'research')).state).toBe('succeeded');
    await stopWorker();
  });

  it('persistent persistence failure becomes UNCERTAIN: no blind re-run; reconcile allows one explicit re-run', async () => {
    const executor = new CountingExecutor();
    repo.failCompleteTimes = PERSIST_FAILS_FOREVER;
    worker = await startWorker(env, { executor, repo, persistAttempts: FAST_PERSIST_ATTEMPTS });
    const runId = await startTrackedRun();

    const cause = await rootCause(runId);
    expect(cause.type).toBe('ExecutionOutcomeUncertain');
    expect(cause.message).toMatch(/uncertain/);
    expect(executor.count('researcher')).toBe(1);
    let record = await execution(runId, 'researcher', 'research');
    expect(record.state).toBe('uncertain');
    expect(record.attempts).toBe(1);
    const stored = await env.db.query('SELECT 1 FROM results WHERE run_id=$1', [runId]);
    expect(stored.rowCount).toBe(0);

    // Operator reconciliation, then start the run again with the same id (allowed after a failed run).
    repo.failCompleteTimes = 0;
    expect(await repo.resetUncertain(record.executionId)).toBe(true);
    await startTrackedRun(runId);
    await waitForGate(env, runId);
    record = await execution(runId, 'researcher', 'research');
    expect(record.state).toBe('succeeded');
    expect(record.attempts).toBe(2);
    expect(executor.count('researcher')).toBe(2);
    const cost = await env.db.query('SELECT attempts FROM cost_entries WHERE entry_id=$1', [
      record.executionId,
    ]);
    expect(cost.rows).toEqual([{ attempts: 2 }]);
    await stopWorker();
  });

  it('stored results are reused across a fresh workflow start without calling the executor', async () => {
    const executor = new CountingExecutor();
    worker = await startWorker(env, { executor, repo });
    const runId = await startTrackedRun();
    await waitForGate(env, runId);
    await terminateQuietly(env, runId);
    expect(executor.count()).toBe(2);

    await startTrackedRun(runId);
    await waitForGate(env, runId);
    expect(executor.count()).toBe(2);
    const stored = await env.db.query('SELECT 1 FROM results WHERE run_id=$1', [runId]);
    expect(stored.rowCount).toBe(2);
    await stopWorker();
  });

  it('an executor error after a possible start is uncertain; a definitive "not started" error is not counted as an attempt', async () => {
    const runA = await seededRun('exec');
    const providerFailure = new CountingExecutor();
    providerFailure.failure = new Error('provider timeout');
    await expect(
      runAgentStage(stageDeps(providerFailure), researchStage(runA)),
    ).rejects.toMatchObject({ type: 'ExecutionOutcomeUncertain' });
    expect((await execution(runA, 'researcher', 'research')).state).toBe('uncertain');

    const runB = await seededRun('exec');
    const notStarted = new CountingExecutor();
    notStarted.failure = new ExecutorNotStartedError('rejected before any external call');
    await expect(runAgentStage(stageDeps(notStarted), researchStage(runB))).rejects.toMatchObject({
      type: 'ExecutorNotStarted',
    });
    const record = await execution(runB, 'researcher', 'research');
    expect(record.state).toBe('pending');
    expect(record.attempts).toBe(0);
  });

  it('concurrent attempts for the same key never both start the executor', async () => {
    const runId = await seededRun('conc');
    const executor = new CountingExecutor();
    executor.delayMs = SLOW_EXECUTOR_MS;
    const deps = stageDeps(executor);

    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () => runAgentStage(deps, researchStage(runId))),
    );

    expect(executor.count()).toBe(1);
    expect(settled.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ type: 'ExecutionInProgress' });
      }
    }
    const again = await runAgentStage(deps, researchStage(runId));
    expect(again.reused).toBe(true);
    expect(executor.count()).toBe(1);
    expect(executor.calls[0]?.idempotencyKey).toMatch(
      new RegExp(`^${runId}:researcher:research:[a-f0-9]{16}$`),
    );
  });

  it('a stale attempt cannot overwrite a newer one (fencing)', async () => {
    const runId = await seededRun('fence');
    const executionId = executionIdFor(runId, 'researcher', 'research');
    await repo.ensureExecution({
      executionId,
      runId,
      role: 'researcher',
      stage: 'research',
      inputDigest: 'd'.repeat(64),
    });
    const staleToken = randomUUID();
    const stale = await repo.claimExecution(executionId, staleToken, SHORT_LEASE_MS);
    expect(await repo.claimExecution(executionId, randomUUID(), SHORT_LEASE_MS)).toBeUndefined();

    await sleep(LEASE_EXPIRY_WAIT_MS); // the lease expires although the external call never started
    const freshToken = randomUUID();
    const fresh = await repo.claimExecution(executionId, freshToken, 5000);
    expect(fresh?.fence).toBe((stale?.fence ?? 0) + 1);

    const result: Result = {
      resultId: `${runId}-research-proposal`,
      taskId: `task-${runId}`,
      runId,
      kind: 'research-proposal',
      producedBy: 'mock',
      payload: { stale: true },
      createdAt: new Date().toISOString(),
    };
    const completion = {
      executionId,
      output: {},
      executedBy: 'mock' as const,
      costUsd: 0,
      steps: 1,
    };
    await expect(
      repo.completeExecution({
        ...completion,
        token: staleToken,
        fence: stale?.fence ?? 0,
        result,
      }),
    ).rejects.toBeInstanceOf(StaleExecutionError);
    await expect(
      repo.markInvoked(executionId, staleToken, stale?.fence ?? 0),
    ).rejects.toBeInstanceOf(StaleExecutionError);

    await repo.markInvoked(executionId, freshToken, fresh?.fence ?? 0);
    await repo.completeExecution({
      ...completion,
      token: freshToken,
      fence: fresh?.fence ?? 0,
      output: { fresh: true },
      result: { ...result, payload: { fresh: true } },
    });
    expect((await repo.getResult(result.resultId))?.payload).toEqual({ fresh: true });
  });

  it('an invoked attempt that was abandoned becomes uncertain and is never re-claimed', async () => {
    const runId = await seededRun('abandon');
    const executionId = executionIdFor(runId, 'researcher', 'research');
    await repo.ensureExecution({
      executionId,
      runId,
      role: 'researcher',
      stage: 'research',
      inputDigest: digestPayload({ goal: 'g', constraints }),
    });
    const token = randomUUID();
    const claim = await repo.claimExecution(executionId, token, SHORT_LEASE_MS);
    await repo.markInvoked(executionId, token, claim?.fence ?? 0);
    await sleep(LEASE_EXPIRY_WAIT_MS);

    expect(await repo.claimExecution(executionId, randomUUID(), SHORT_LEASE_MS)).toBeUndefined();
    const executor = new CountingExecutor();
    await expect(runAgentStage(stageDeps(executor), researchStage(runId))).rejects.toMatchObject({
      type: 'ExecutionOutcomeUncertain',
    });
    expect(executor.count()).toBe(0);
    expect((await repo.getExecution(executionId))?.state).toBe('uncertain');
  });

  it('a changed input for an existing stage is refused instead of silently reusing or re-running', async () => {
    const runId = await seededRun('mismatch');
    const executor = new CountingExecutor();
    await runAgentStage(stageDeps(executor), researchStage(runId));
    await expect(
      runAgentStage(stageDeps(executor), {
        ...researchStage(runId),
        input: { goal: 'a different goal', constraints },
      }),
    ).rejects.toMatchObject({ type: 'ExecutionInputMismatch' });
    expect(executor.count()).toBe(1);
  });

  it('reuse repairs a missing task projection without calling the executor', async () => {
    const runId = await seededRun('repair');
    const executor = new CountingExecutor();
    let projectionFailuresLeft = 1;
    const failingProjection: TaskStore = {
      createTask: (task) => env.tasks.createTask(task),
      getTask: (taskId) => env.tasks.getTask(taskId),
      changeStatus: (taskId, status) => env.tasks.changeStatus(taskId, status),
      recordApproval: (taskId, approval) => env.tasks.recordApproval(taskId, approval),
      getResults: (taskId) => env.tasks.getResults(taskId),
      getApprovals: (taskId) => env.tasks.getApprovals(taskId),
      locate: (taskId) => env.tasks.locate(taskId),
      attachResult: async (taskId, result) => {
        if (projectionFailuresLeft-- > 0) {
          throw new Error('injected: projection failed after canonical persistence');
        }
        return env.tasks.attachResult(taskId, result);
      },
    };
    await expect(
      runAgentStage(stageDeps(executor, failingProjection), researchStage(runId)),
    ).rejects.toThrow(/projection failed/);
    expect(await env.tasks.getResults(`task-${runId}`)).toHaveLength(0);

    const repaired = await runAgentStage(stageDeps(executor), researchStage(runId));
    expect(repaired.reused).toBe(true);
    expect(executor.count()).toBe(1);
    const task = taskSchema.parse(await env.tasks.getTask(`task-${runId}`));
    expect(task.resultIds).toEqual([`${runId}-research-proposal`]);
  });

  it('losing ownership before the external call is a retryable "in progress" failure and the executor never runs', async () => {
    const runId = await seededRun('lost');
    const executor = new CountingExecutor();
    repo.markInvokedFailure = new StaleExecutionError('lost claim');
    await expect(runAgentStage(stageDeps(executor), researchStage(runId))).rejects.toMatchObject({
      type: 'ExecutionInProgress',
    });
    expect(executor.count()).toBe(0);
  });

  it('a result that cannot be stored because ownership was lost is uncertain, and stays uncertain on every later attempt', async () => {
    const runId = await seededRun('stale-persist');
    const executor = new CountingExecutor();
    repo.completeFailure = new StaleExecutionError('another attempt owns it now');
    await expect(runAgentStage(stageDeps(executor), researchStage(runId))).rejects.toMatchObject({
      type: 'ExecutionOutcomeUncertain',
    });
    repo.completeFailure = undefined;

    const record = await execution(runId, 'researcher', 'research');
    expect(record.state).toBe('uncertain');
    expect(record.uncertainReason).toContain('no longer owns');
    await expect(runAgentStage(stageDeps(executor), researchStage(runId))).rejects.toMatchObject({
      type: 'ExecutionOutcomeUncertain',
    });
    expect(executor.count()).toBe(1);
  });

  it('output that fails validation is never persisted and marks the execution uncertain', async () => {
    const runId = await seededRun('invalid');
    const executor = new CountingExecutor();
    await expect(
      runAgentStage(stageDeps(executor), {
        ...researchStage(runId),
        validateOutput: () => {
          throw new Error('schema violation');
        },
      }),
    ).rejects.toMatchObject({ type: 'ExecutionOutcomeUncertain' });
    expect((await execution(runId, 'researcher', 'research')).uncertainReason).toContain(
      'invalid executor output: schema violation',
    );
    expect(await resultIds(env, runId)).toEqual([]);
  });

  it('a succeeded execution whose canonical result vanished fails loudly instead of re-running', async () => {
    const runId = await seededRun('vanished');
    const executor = new CountingExecutor();
    await runAgentStage(stageDeps(executor), researchStage(runId));
    await env.db.query('DELETE FROM results WHERE run_id=$1', [runId]);

    await expect(runAgentStage(stageDeps(executor), researchStage(runId))).rejects.toMatchObject({
      type: 'CanonicalResultMissing',
    });
    expect(executor.count()).toBe(1);
  });
});
