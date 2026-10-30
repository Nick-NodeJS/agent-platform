import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowFailedError } from '@temporalio/client';
import type { Result, TaskStore } from '@platform/contracts';
import { MockAgentExecutor, RealExecutionNotImplementedError } from '@platform/integrations';
import { RunRepository, StaleExecutionError } from '@platform/persistence';
import { runAgentStage, executionIdFor } from '../../apps/worker/src/agent-stage.js';
import { researchProposalSchema } from '@platform/contracts';
import { digestPayload } from '@platform/contracts/node';
import {
  CountingExecutor,
  constraints,
  createEnv,
  newRunId,
  startRun,
  startWorker,
  terminateQuietly,
  waitForGate,
  type Env,
  type RunningWorker,
} from './harness.js';

/** Repository that can fail a method N times to model crashes at precise points. */
class FaultyRepo extends RunRepository {
  failComplete = 0;
  override async completeExecution(...args: Parameters<RunRepository['completeExecution']>) {
    if (this.failComplete > 0) {
      this.failComplete--;
      throw new Error('injected: database unavailable while persisting result');
    }
    return super.completeExecution(...args);
  }
}

describe('durable agent executions and Activity retries (live Temporal + Postgres)', () => {
  let env: Env;
  let repo: FaultyRepo;
  const runs: string[] = [];
  const track = (id: string) => (runs.push(id), id);
  let worker: RunningWorker | undefined;

  beforeAll(async () => {
    env = await createEnv();
    repo = new FaultyRepo(env.db);
  });
  afterAll(async () => {
    for (const r of runs) await terminateQuietly(env, r);
    await worker?.stop();
    await env?.cleanup();
  });

  const execState = async (runId: string, role: string, stage: string) =>
    (await repo.getExecution(executionIdFor(runId, role, stage)))!;

  const failure = async (runId: string) => {
    try {
      await env.client.workflow.getHandle(runId).result();
    } catch (e) {
      if (e instanceof WorkflowFailedError) {
        type Cause = { message?: string; type?: string; cause?: Cause };
        let c = e.cause as Cause | undefined;
        while (c?.cause) c = c.cause;
        return c;
      }
      throw e;
    }
    throw new Error('workflow unexpectedly succeeded');
  };

  const stageDeps = (executor: CountingExecutor, tasks: TaskStore = env.tasks) => ({
    repo,
    tasks,
    executor,
    leaseTtlMs: 5000,
  });
  const stageArgs = (runId: string, taskId: string) => ({
    runId,
    taskId,
    role: 'researcher' as const,
    stage: 'research',
    kind: 'research-proposal' as const,
    resultId: `${runId}-research-proposal`,
    input: { goal: 'g', constraints },
    validateOutput: (o: unknown) => researchProposalSchema.parse(o),
  });
  const seedRun = async (runId: string) => {
    const ts = new Date().toISOString();
    await repo.insertRun({
      runId,
      workflowId: runId,
      taskId: `task-${runId}`,
      goal: 'g',
      constraints,
      status: 'CREATED',
      createdAt: ts,
      updatedAt: ts,
    });
    await env.tasks.createTask({
      taskId: `task-${runId}`,
      runId,
      title: 't',
      description: 'd',
      status: 'CREATED',
      resultIds: [],
      approvalIds: [],
      createdAt: ts,
      updatedAt: ts,
    });
  };

  it('failure after external completion and canonical persistence, before task projection: Activity retry reuses the stored result', async () => {
    const exec = new CountingExecutor();
    let failures = 1;
    const flakyTasks = Object.create(env.tasks) as TaskStore;
    flakyTasks.attachResult = async (taskId, result) => {
      if (failures-- > 0) throw new Error('injected: task projection failed');
      return env.tasks.attachResult(taskId, result);
    };
    worker = await startWorker(env, { executor: exec, tasks: flakyTasks, repo });
    const runId = track(await startRun(env));
    await waitForGate(env, runId);

    expect(exec.count('researcher')).toBe(1);
    expect(exec.count('business-owner')).toBe(1);
    const rec = await execState(runId, 'researcher', 'research');
    expect(rec.state).toBe('succeeded');
    expect(rec.attempts).toBe(1);
    const file = JSON.parse(readFileSync(path.join(env.tasksDir, `task-${runId}.json`), 'utf8'));
    expect(file.results.map((r: Result) => r.kind).sort()).toEqual([
      'business-evaluation',
      'research-proposal',
    ]);
    expect(
      (await env.db.query('SELECT count(*)::int AS n FROM cost_entries WHERE run_id=$1', [runId]))
        .rows[0].n,
    ).toBe(2);
    await worker.stop();
    worker = undefined;
  });

  it('failure after the whole Activity body completed: Activity retry is a pure reuse (no second execution)', async () => {
    const exec = new CountingExecutor();
    let failures = 1;
    worker = await startWorker(
      env,
      { executor: exec, repo },
      (acts) =>
        ({
          ...acts,
          runResearcher: async (a: Parameters<typeof acts.runResearcher>[0]) => {
            const r = await acts.runResearcher(a);
            if (failures-- > 0)
              throw new Error('injected: worker died right after the Activity finished');
            return r;
          },
        }) as never,
    );
    const runId = track(await startRun(env));
    await waitForGate(env, runId);
    expect(exec.count('researcher')).toBe(1);
    expect((await execState(runId, 'researcher', 'research')).attempts).toBe(1);
    await worker.stop();
    worker = undefined;
  });

  it('transient persistence failure after the executor finished is retried in-attempt without a second execution', async () => {
    const exec = new CountingExecutor();
    repo.failComplete = 1;
    worker = await startWorker(env, { executor: exec, repo });
    const runId = track(await startRun(env));
    await waitForGate(env, runId);
    expect(exec.count('researcher')).toBe(1);
    expect((await execState(runId, 'researcher', 'research')).state).toBe('succeeded');
    await worker.stop();
    worker = undefined;
  });

  it('persistent persistence failure after external completion becomes UNCERTAIN: no blind re-run; reconcile allows an explicit one', async () => {
    const exec = new CountingExecutor();
    repo.failComplete = 1000;
    worker = await startWorker(env, { executor: exec, repo, persistAttempts: 2 });
    const runId = track(await startRun(env));
    const f = await failure(runId);
    expect(f?.type).toBe('ExecutionOutcomeUncertain');
    expect(f?.message).toMatch(/uncertain/);
    expect(exec.count('researcher')).toBe(1);
    let rec = await execState(runId, 'researcher', 'research');
    expect(rec.state).toBe('uncertain');
    expect(rec.attempts).toBe(1);
    expect((await env.db.query('SELECT 1 FROM results WHERE run_id=$1', [runId])).rowCount).toBe(0);

    // Operator reconciliation, then starting the run again with the same id (workflow ids are reusable after failure).
    repo.failComplete = 0;
    expect(await repo.resetUncertain(rec.executionId)).toBe(true);
    await startRun(env, runId);
    await waitForGate(env, runId);
    rec = await execState(runId, 'researcher', 'research');
    expect(rec.state).toBe('succeeded');
    expect(rec.attempts).toBe(2); // actual attempts are accounted, not hidden
    expect(exec.count('researcher')).toBe(2);
    expect(
      (await env.db.query('SELECT attempts FROM cost_entries WHERE entry_id=$1', [rec.executionId]))
        .rows[0].attempts,
    ).toBe(2);
    await worker.stop();
    worker = undefined;
  });

  it('a stage whose execution is reused never calls the executor again, even across a fresh workflow start', async () => {
    const exec = new CountingExecutor();
    worker = await startWorker(env, { executor: exec, repo });
    const runId = track(await startRun(env));
    await waitForGate(env, runId);
    await terminateQuietly(env, runId);
    expect(exec.count()).toBe(2);
    await startRun(env, runId); // same run id: tasks, results, and executions are reused
    await waitForGate(env, runId);
    expect(exec.count()).toBe(2);
    expect((await env.db.query('SELECT 1 FROM results WHERE run_id=$1', [runId])).rowCount).toBe(2);
    await worker.stop();
    worker = undefined;
  });

  it('executor errors after a possible start are uncertain; definitive not-started errors are not counted', async () => {
    const runA = newRunId('exec');
    await seedRun(runA);
    const boom = new CountingExecutor();
    boom.run = async () => {
      throw new Error('provider timeout');
    };
    await expect(
      runAgentStage(stageDeps(boom), stageArgs(runA, `task-${runA}`)),
    ).rejects.toMatchObject({
      type: 'ExecutionOutcomeUncertain',
    });
    expect((await execState(runA, 'researcher', 'research')).state).toBe('uncertain');

    const runB = newRunId('exec');
    await seedRun(runB);
    const notStarted = new CountingExecutor();
    notStarted.run = async () => {
      throw new RealExecutionNotImplementedError('real execution not implemented');
    };
    await expect(
      runAgentStage(stageDeps(notStarted), stageArgs(runB, `task-${runB}`)),
    ).rejects.toMatchObject({
      type: 'ExecutorNotStarted',
    });
    const rec = await execState(runB, 'researcher', 'research');
    expect(rec.state).toBe('pending');
    expect(rec.attempts).toBe(0);
  });

  it('concurrent attempts for the same key do not both start; the loser backs off or reuses', async () => {
    const runId = newRunId('conc');
    await seedRun(runId);
    const exec = new CountingExecutor();
    exec.delayMs = 700;
    const deps = stageDeps(exec);
    const settled = await Promise.allSettled(
      Array.from({ length: 5 }, () => runAgentStage(deps, stageArgs(runId, `task-${runId}`))),
    );
    expect(exec.count()).toBe(1);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    for (const s of settled.filter((s) => s.status === 'rejected'))
      expect((s as PromiseRejectedResult).reason).toMatchObject({ type: 'ExecutionInProgress' });
    // After the winner finished, any further attempt is a pure reuse.
    const again = await runAgentStage(deps, stageArgs(runId, `task-${runId}`));
    expect(again.reused).toBe(true);
    expect(exec.count()).toBe(1);
    const key = exec.calls[0]!.idempotencyKey;
    expect(key).toMatch(new RegExp(`^${runId}:researcher:research:[a-f0-9]{16}$`));
  });

  it('stale attempts cannot overwrite newer results (fencing), and an invoked-but-abandoned execution becomes uncertain', async () => {
    const runId = newRunId('fence');
    await seedRun(runId);
    const id = executionIdFor(runId, 'researcher', 'research');
    await repo.ensureExecution({
      executionId: id,
      runId,
      role: 'researcher',
      stage: 'research',
      inputDigest: 'd'.repeat(64),
    });
    const t1 = randomUUID();
    const c1 = (await repo.claimExecution(id, t1, 1000))!;
    expect(await repo.claimExecution(id, randomUUID(), 1000)).toBeUndefined(); // live lease blocks others
    await new Promise((r) => setTimeout(r, 1300)); // lease expires; the external call was never started
    const t2 = randomUUID();
    const c2 = (await repo.claimExecution(id, t2, 5000))!;
    expect(c2.fence).toBe(c1.fence + 1);
    const result: Result = {
      resultId: `${runId}-research-proposal`,
      taskId: `task-${runId}`,
      runId,
      kind: 'research-proposal',
      producedBy: 'mock',
      payload: { stale: true },
      createdAt: new Date().toISOString(),
    };
    const done = { executionId: id, output: {}, executedBy: 'mock', costUsd: 0, steps: 1, result };
    await expect(
      repo.completeExecution({ ...done, token: t1, fence: c1.fence }),
    ).rejects.toBeInstanceOf(StaleExecutionError);
    await expect(repo.markInvoked(id, t1, c1.fence)).rejects.toBeInstanceOf(StaleExecutionError);
    await repo.markInvoked(id, t2, c2.fence);
    await repo.completeExecution({
      ...done,
      token: t2,
      fence: c2.fence,
      output: { fresh: true },
      result: { ...result, payload: { fresh: true } },
    });
    expect((await repo.getResult(result.resultId))?.payload).toEqual({ fresh: true });

    // Abandoned after invocation: a short lease expires with invoked_at set -> uncertain, never re-claimed.
    const run2 = newRunId('fence');
    await seedRun(run2);
    const id2 = executionIdFor(run2, 'researcher', 'research');
    await repo.ensureExecution({
      executionId: id2,
      runId: run2,
      role: 'researcher',
      stage: 'research',
      inputDigest: digestPayload({ goal: 'g', constraints }),
    });
    const t3 = randomUUID();
    const c3 = (await repo.claimExecution(id2, t3, 1000))!;
    await repo.markInvoked(id2, t3, c3.fence);
    await new Promise((r) => setTimeout(r, 1300));
    expect(await repo.claimExecution(id2, randomUUID(), 1000)).toBeUndefined();
    const exec = new CountingExecutor();
    await expect(
      runAgentStage(stageDeps(exec), stageArgs(run2, `task-${run2}`)),
    ).rejects.toMatchObject({
      type: 'ExecutionOutcomeUncertain',
    });
    expect(exec.count()).toBe(0);
    expect((await repo.getExecution(id2))?.state).toBe('uncertain');
  });

  it('changed input for an existing stage is refused instead of silently reusing or re-running', async () => {
    const runId = newRunId('mismatch');
    await seedRun(runId);
    const exec = new CountingExecutor();
    await runAgentStage(stageDeps(exec), stageArgs(runId, `task-${runId}`));
    await expect(
      runAgentStage(stageDeps(exec), {
        ...stageArgs(runId, `task-${runId}`),
        input: { goal: 'different', constraints },
      }),
    ).rejects.toMatchObject({ type: 'ExecutionInputMismatch' });
    expect(exec.count()).toBe(1);
    expect(new MockAgentExecutor()).toBeTruthy();
  });
});
