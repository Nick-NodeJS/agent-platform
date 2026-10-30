import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Approval, Result, Run } from '@platform/contracts';
import { ExecutionInputMismatchError, migrate } from '@platform/persistence';
import { constraints, createEnv, newRunId, type Env } from './harness.js';

const DIGEST = 'd'.repeat(64);
const LEASE_MS = 5000;

describe('PostgreSQL repository and migrations (temporary database)', () => {
  let env: Env;

  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(async () => {
    await env?.cleanup();
  });

  const timestamp = () => new Date().toISOString();

  const insertRun = async (runId = newRunId('db')): Promise<Run> => {
    const run: Run = {
      runId,
      workflowId: runId,
      taskId: `task-${runId}`,
      goal: 'g',
      constraints,
      status: 'CREATED',
      createdAt: timestamp(),
      updatedAt: timestamp(),
    };
    await env.repo.insertRun(run);
    return run;
  };

  const resultFor = (run: Run, resultId = `${run.runId}-r`): Result => ({
    resultId,
    taskId: run.taskId,
    runId: run.runId,
    kind: 'research-proposal',
    producedBy: 'mock',
    payload: { a: 1 },
    digest: DIGEST,
    createdAt: timestamp(),
  });

  const approvalFor = (run: Run, overrides: Partial<Approval> = {}): Approval => ({
    approvalId: `${run.runId}-final-decision`,
    taskId: run.taskId,
    runId: run.runId,
    decision: 'approve',
    source: 'human',
    actor: 'tester',
    decisionId: `dec-${randomUUID().slice(0, 8)}`,
    createdAt: timestamp(),
    ...overrides,
  });

  it('applies migrations once, in order, and is a no-op the second time', async () => {
    expect(await migrate(env.db)).toEqual([]);
    const tracked = await env.db.query('SELECT name FROM schema_migrations ORDER BY name');
    expect(tracked.rows.map((row: { name: string }) => row.name)).toEqual([
      '001_init.sql',
      '002_gates_executions.sql',
    ]);
  });

  it('rolls back a failing migration completely and does not record it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    try {
      await writeFile(path.join(dir, '900_good.sql'), 'CREATE TABLE migration_probe (id INT);');
      await writeFile(
        path.join(dir, '901_bad.sql'),
        'CREATE TABLE migration_probe_two (id INT); SELECT * FROM table_that_does_not_exist;',
      );
      await expect(migrate(env.db, dir)).rejects.toThrow(/table_that_does_not_exist/);
      const created = await env.db.query(
        "SELECT to_regclass('migration_probe') AS good, to_regclass('migration_probe_two') AS bad",
      );
      expect(created.rows).toEqual([{ good: 'migration_probe', bad: null }]);
      const tracked = await env.db.query("SELECT name FROM schema_migrations WHERE name >= '900'");
      expect(tracked.rows).toEqual([{ name: '900_good.sql' }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('run status only moves forward and terminal statuses are never overwritten', async () => {
    const run = await insertRun();
    const statusOf = async () => {
      const found = await env.db.query('SELECT status FROM runs WHERE run_id=$1', [run.runId]);
      return z.object({ status: z.string() }).parse(found.rows[0]).status;
    };

    await env.repo.updateStatus(run.runId, 'EVALUATING');
    await env.repo.updateStatus(run.runId, 'RESEARCHING');
    expect(await statusOf()).toBe('EVALUATING');
    await env.repo.updateStatus(run.runId, 'REJECTED');
    await env.repo.updateStatus(run.runId, 'APPROVED');
    await env.repo.updateStatus(run.runId, 'WAITING_FOR_HUMAN_APPROVAL');
    expect(await statusOf()).toBe('REJECTED');
  });

  it('inserts are idempotent: duplicate runs, results, events and costs create one row', async () => {
    const run = await insertRun();
    await env.repo.insertRun(run);
    const result = resultFor(run);
    await env.repo.insertResult(result);
    await env.repo.insertResult(result);
    const event = {
      eventId: `${run.runId}:e`,
      runId: run.runId,
      type: 't',
      data: {},
      createdAt: timestamp(),
    };
    await env.repo.insertEvent(event);
    await env.repo.insertEvent(event);
    const cost = {
      entryId: `${run.runId}:c`,
      runId: run.runId,
      role: 'researcher',
      costUsd: 0.5,
      steps: 2,
    };
    await env.repo.insertCost(cost);
    await env.repo.insertCost(cost);

    const summary = await env.repo.getRunSummary(run.runId);
    expect(summary?.results).toHaveLength(1);
    expect(summary?.events).toHaveLength(1);
    expect(summary?.totalCostUsd).toBe(0.5);
    expect(await env.repo.getResult(result.resultId)).toMatchObject({
      payload: { a: 1 },
      digest: DIGEST,
    });
    expect(await env.repo.getResult('missing-result')).toBeUndefined();
    expect(await env.repo.getRunSummary(newRunId('unknown'))).toBeUndefined();
  });

  it('stores exactly one decision per run (first wins) and detects reused decision ids', async () => {
    const run = await insertRun();
    const first = approvalFor(run, { decision: 'approve', decisionId: 'dec-first' });
    expect(await env.repo.insertApproval(first)).toBe(true);
    expect(
      await env.repo.insertApproval(
        approvalFor(run, { decision: 'reject', decisionId: 'dec-second' }),
      ),
    ).toBe(false);

    expect(await env.repo.hasDecisionId('dec-first')).toBe(true);
    expect(await env.repo.hasDecisionId('dec-second')).toBe(false);
    const rows = await env.db.query('SELECT decision FROM approvals WHERE run_id=$1', [run.runId]);
    expect(rows.rows).toEqual([{ decision: 'approve' }]);
  });

  it('opening a gate twice returns the first gate unchanged; closing marks it decided', async () => {
    const run = await insertRun();
    const gateId = `gate-${run.runId}`.slice(0, 60);
    const artifacts = [{ resultId: `${run.runId}-r`, digest: DIGEST }];
    const first = await env.repo.openGate({ gateId, runId: run.runId, artifacts });
    const second = await env.repo.openGate({
      gateId: `${gateId}-other`.slice(0, 63),
      runId: run.runId,
      artifacts: [{ resultId: 'other', digest: 'e'.repeat(64) }],
    });
    expect(second).toEqual(first);

    await env.repo.closeGate(gateId);
    const status = await env.db.query('SELECT status FROM review_gates WHERE gate_id=$1', [gateId]);
    expect(status.rows).toEqual([{ status: 'decided' }]);
  });

  it('execution lifecycle: ensure is idempotent, input changes are refused, reset only affects uncertain', async () => {
    const run = await insertRun();
    const executionId = `${run.runId}:researcher:research`;
    const spec = {
      executionId,
      runId: run.runId,
      role: 'researcher',
      stage: 'research',
      inputDigest: DIGEST,
    };

    expect((await env.repo.ensureExecution(spec)).state).toBe('pending');
    expect((await env.repo.ensureExecution(spec)).attempts).toBe(0);
    await expect(
      env.repo.ensureExecution({ ...spec, inputDigest: 'f'.repeat(64) }),
    ).rejects.toBeInstanceOf(ExecutionInputMismatchError);
    expect(await env.repo.resetUncertain(executionId)).toBe(false);

    const token = randomUUID();
    const claim = await env.repo.claimExecution(executionId, token, LEASE_MS);
    expect(claim?.state).toBe('running');
    expect(await env.repo.renewLease(executionId, token, claim?.fence ?? 0, LEASE_MS)).toBe(true);
    expect(await env.repo.renewLease(executionId, randomUUID(), claim?.fence ?? 0, LEASE_MS)).toBe(
      false,
    );

    await env.repo.markInvoked(executionId, token, claim?.fence ?? 0);
    await env.repo.abortInvocation(executionId, token, claim?.fence ?? 0);
    const aborted = await env.repo.getExecution(executionId);
    expect(aborted).toMatchObject({ state: 'pending', attempts: 0, invokedAt: null });

    const retryToken = randomUUID();
    const retry = await env.repo.claimExecution(executionId, retryToken, LEASE_MS);
    await env.repo.markInvoked(executionId, retryToken, retry?.fence ?? 0);
    await env.repo.markUncertainOwned(executionId, retryToken, retry?.fence ?? 0, 'test reason');
    expect(await env.repo.getExecution(executionId)).toMatchObject({
      state: 'uncertain',
      uncertainReason: 'test reason',
    });
    expect(await env.repo.markUncertainIfAbandoned(executionId, 'not applicable')).toBe(false);
    expect(await env.repo.resetUncertain(executionId)).toBe(true);
    expect((await env.repo.listExecutions(run.runId)).map((execution) => execution.state)).toEqual([
      'pending',
    ]);
  });
});
