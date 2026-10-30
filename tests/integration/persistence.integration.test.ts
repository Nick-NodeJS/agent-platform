import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Result, Run } from '@platform/contracts';
import { digestPayload } from '@platform/contracts/node';
import {
  DecisionConflictError,
  ExecutionInputMismatchError,
  migrate,
  type StoredApproval,
} from '@platform/persistence';
import {
  approvalRows,
  constraints,
  createEnv,
  newRunId,
  signForGate,
  type Env,
} from './harness.js';

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

  /** A gate for the run and a correctly shaped decision (signed envelope plus the approval row derived from it). */
  const decisionFor = async (
    run: Run,
    decision: 'approve' | 'reject',
    decisionId = `dec-${randomUUID().slice(0, 10)}`,
  ) => {
    const gateId = `gate-${run.runId}`.slice(0, 60);
    const gate = await env.repo.openGate({
      gateId,
      runId: run.runId,
      artifacts: [{ resultId: `${run.runId}-r`, digest: DIGEST }],
    });
    const envelope = signForGate(gate, { decision, decisionId }, env.signer);
    const approval: StoredApproval = {
      approvalId: `${run.runId}-final-decision`,
      taskId: run.taskId,
      runId: run.runId,
      decision,
      source: 'human',
      actor: env.signer.actor,
      decisionId,
      keyId: env.signer.keyId,
      envelopeDigest: digestPayload(envelope),
      createdAt: timestamp(),
    };
    return { gate, envelope, approval, args: { approval, envelope, gateId: gate.gateId } };
  };

  const storedApprovals = (runId: string) => approvalRows(env, runId);

  it('records one decision per run in a transaction that also closes the gate; identical retries are idempotent', async () => {
    const run = await insertRun();
    const first = await decisionFor(run, 'approve', 'dec-first');

    const created = await env.repo.recordDecision(first.args);
    expect(created.created).toBe(true);
    expect(created.approval).toMatchObject({
      decision: 'approve',
      decisionId: 'dec-first',
      actor: 'it-human',
    });
    const gate = await env.db.query('SELECT status FROM review_gates WHERE gate_id=$1', [
      first.gate.gateId,
    ]);
    expect(gate.rows).toEqual([{ status: 'decided' }]);

    const retried = await env.repo.recordDecision({
      ...first.args,
      approval: { ...first.approval, createdAt: timestamp() },
    });
    expect(retried.created).toBe(false);
    expect(retried.approval).toEqual(created.approval);
    expect(await storedApprovals(run.runId)).toMatchObject([
      { decision: 'approve', decision_id: 'dec-first', key_id: 'it-key' },
    ]);
    expect(await env.repo.hasDecisionId('dec-first')).toBe(true);
    expect(await env.repo.hasDecisionId('dec-unused')).toBe(false);
  });

  it('refuses a different decision, envelope or decision id for a decided run, and a decision id used by another run', async () => {
    const run = await insertRun();
    const first = await decisionFor(run, 'approve', 'dec-a');
    await env.repo.recordDecision(first.args);

    const opposite = await decisionFor(run, 'reject', 'dec-b');
    await expect(env.repo.recordDecision(opposite.args)).rejects.toBeInstanceOf(
      DecisionConflictError,
    );
    const sameDecisionNewId = await decisionFor(run, 'approve', 'dec-c');
    await expect(env.repo.recordDecision(sameDecisionNewId.args)).rejects.toBeInstanceOf(
      DecisionConflictError,
    );
    const differentEnvelope = {
      ...first.args,
      approval: { ...first.approval, envelopeDigest: 'f'.repeat(64) },
    };
    await expect(env.repo.recordDecision(differentEnvelope)).rejects.toBeInstanceOf(
      DecisionConflictError,
    );
    expect(await storedApprovals(run.runId)).toMatchObject([
      { decision: 'approve', decision_id: 'dec-a', key_id: 'it-key' },
    ]);

    const other = await insertRun();
    const replay = await decisionFor(other, 'approve', 'dec-a');
    await expect(env.repo.recordDecision(replay.args)).rejects.toThrow(
      /already used by another run/,
    );
    expect(await storedApprovals(other.runId)).toEqual([]);
  });

  it('concurrent attempts serialize on the run row: exactly one decision is created, the rest match it or conflict', async () => {
    const run = await insertRun();
    const identical = await decisionFor(run, 'approve', 'dec-same');
    const rivals = await Promise.all(
      (['reject', 'approve', 'reject'] as const).map((decision, i) =>
        decisionFor(run, decision, `dec-rival-${i}`),
      ),
    );
    const attempts = [
      ...Array.from({ length: 4 }, () => identical.args),
      ...rivals.map((rival) => rival.args),
    ];

    const outcomes = await Promise.allSettled(
      attempts.map((args) => env.repo.recordDecision(args)),
    );

    const stored = await storedApprovals(run.runId);
    expect(stored).toHaveLength(1);
    const winner = stored[0]?.decision_id;
    const fulfilled = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    expect(fulfilled.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(fulfilled.map((outcome) => outcome.approval.decisionId))).toEqual(
      new Set([winner]),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(DecisionConflictError);
      }
    }
  });

  it('an approval stored before signer identity was recorded still protects the run id and is never overwritten', async () => {
    const run = await insertRun();
    await env.db.query(
      `INSERT INTO approvals (approval_id, run_id, task_id, decision, source, actor, created_at)
       VALUES ($1, $2, $3, 'approve', 'human', 'legacy-actor', now())`,
      [`${run.runId}-final-decision`, run.runId, run.taskId],
    );

    expect((await env.repo.getDecisionState(run.runId))?.hasDecision).toBe(true);
    const attempt = await decisionFor(run, 'approve');
    await expect(env.repo.recordDecision(attempt.args)).rejects.toBeInstanceOf(
      DecisionConflictError,
    );
    const stored = await env.db.query('SELECT actor FROM approvals WHERE run_id=$1', [run.runId]);
    expect(stored.rows).toEqual([{ actor: 'legacy-actor' }]);
  });

  it('keeps the optional reason of a decision when it is retried', async () => {
    const run = await insertRun();
    const decision = await decisionFor(run, 'reject', 'dec-with-reason');
    const withReason = {
      ...decision.args,
      approval: { ...decision.approval, reason: 'not viable' },
    };

    const created = await env.repo.recordDecision(withReason);
    const retried = await env.repo.recordDecision(withReason);

    expect(created.approval.reason).toBe('not viable');
    expect(retried).toEqual({ approval: created.approval, created: false });
    await expect(env.repo.recordDecision(decision.args)).rejects.toBeInstanceOf(
      DecisionConflictError,
    );
  });

  it('reports a decided run through getDecisionState, from Postgres alone', async () => {
    const fresh = await insertRun();
    expect(await env.repo.getDecisionState(fresh.runId)).toEqual({
      status: 'CREATED',
      hasDecision: false,
      terminal: false,
    });
    expect(await env.repo.getDecisionState(newRunId('absent'))).toBeUndefined();

    const decided = await insertRun();
    await env.repo.recordDecision((await decisionFor(decided, 'reject')).args);
    expect(await env.repo.getDecisionState(decided.runId)).toEqual({
      status: 'CREATED',
      hasDecision: true,
      terminal: false,
    });

    const terminal = await insertRun();
    await env.repo.updateStatus(terminal.runId, 'APPROVED');
    expect(await env.repo.getDecisionState(terminal.runId)).toEqual({
      status: 'APPROVED',
      hasDecision: false,
      terminal: true,
    });
  });

  it('opening a gate twice returns the first gate unchanged', async () => {
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
