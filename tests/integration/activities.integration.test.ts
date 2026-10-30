import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/client';
import { MockAgentExecutor } from '@platform/integrations';
import { RunRepository } from '@platform/persistence';
import { digestPayload } from '@platform/contracts/node';
import type { ApprovalEnvelope, ReviewGate } from '@platform/contracts';
import {
  createActivities,
  DECISION_CONFLICT,
  RUN_ALREADY_DECIDED,
  researchResultId,
} from '../../apps/worker/src/activities.js';
import { constraints, createEnv, newRunId, signForGate, type Env } from './harness.js';

/** Repository whose decision write can be made to fail like an unavailable database. */
class UnavailableDecisionRepo extends RunRepository {
  override async recordDecision(): ReturnType<RunRepository['recordDecision']> {
    throw new Error('injected: database unavailable');
  }
}

/** Calls the Activities directly (no Temporal), the way the workflow would, against a temporary database. */
describe('Activities against Postgres and task files', () => {
  let env: Env;
  const GOAL = 'activity test goal';

  beforeAll(async () => {
    env = await createEnv();
  });
  afterAll(async () => {
    await env?.cleanup();
  });

  const activities = (repo: RunRepository = env.repo) =>
    createActivities({
      repo,
      tasks: env.tasks,
      executor: new MockAgentExecutor(),
      trustedSignersFile: env.trustedFile,
    });

  /** Runs the Activities up to an open gate and returns what is needed to decide it. */
  const openGate = async (runId = newRunId('act')) => {
    const acts = activities();
    const { taskId } = await acts.createTaskAndRun({ runId, goal: GOAL, constraints });
    await acts.runResearcher({ runId, taskId, goal: GOAL, constraints });
    await acts.runBusinessOwner({ runId, taskId, constraints });
    const gate = await acts.openReviewGate({ runId, taskId });
    return { acts, runId, taskId, gate };
  };

  const failureOf = (action: Promise<unknown>) =>
    action.then(
      () => undefined,
      (error: unknown) => error,
    );

  const decide = (
    acts: ReturnType<typeof activities>,
    run: { runId: string; taskId: string; gate: ReviewGate },
    envelope: ApprovalEnvelope,
  ) =>
    acts.recordDecision({
      runId: run.runId,
      taskId: run.taskId,
      gate: run.gate,
      envelope,
      verifiedAt: new Date().toISOString(),
    });

  it('runs the whole decision path and returns the canonical stored decision', async () => {
    const run = await openGate();
    const envelope = signForGate(run.gate, { decision: 'reject', reason: 'not now' }, env.signer);

    const verified = await run.acts.verifyApproval({ envelope, gate: run.gate });
    const canonical = await decide(run.acts, run, envelope);

    expect(verified).toMatchObject({ actor: 'it-human', keyId: 'it-key' });
    expect(canonical).toEqual({
      decision: 'reject',
      source: 'human',
      actor: 'it-human',
      keyId: 'it-key',
      decisionId: envelope.payload.decisionId,
      reason: 'not now',
    });
    expect(await decide(run.acts, run, envelope)).toEqual(canonical); // identical retry
  });

  it('refuses to reuse a decided run id at both entry points and changes nothing', async () => {
    const run = await openGate();
    await decide(run.acts, run, signForGate(run.gate, { decision: 'approve' }, env.signer));
    const before = await env.repo.getRunSummary(run.runId);

    for (const attempt of [
      run.acts.createTaskAndRun({ runId: run.runId, goal: GOAL, constraints }),
      run.acts.openReviewGate({ runId: run.runId, taskId: run.taskId }),
    ]) {
      const failure = await failureOf(attempt);
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({ type: RUN_ALREADY_DECIDED, nonRetryable: true });
    }
    expect(await env.repo.getRunSummary(run.runId)).toEqual(before);
  });

  it('a conflicting decision is a non-retryable DecisionConflict; an unavailable database stays retryable', async () => {
    const run = await openGate();
    await decide(run.acts, run, signForGate(run.gate, { decision: 'approve' }, env.signer));

    const conflict = await failureOf(
      decide(run.acts, run, signForGate(run.gate, { decision: 'reject' }, env.signer)),
    );
    expect(conflict).toMatchObject({ type: DECISION_CONFLICT, nonRetryable: true });

    const undecided = await openGate();
    const unavailable = await failureOf(
      decide(
        activities(new UnavailableDecisionRepo(env.db)),
        undecided,
        signForGate(undecided.gate, { decision: 'approve' }, env.signer),
      ),
    );
    expect(unavailable).toBeInstanceOf(Error);
    expect(unavailable).not.toBeInstanceOf(ApplicationFailure);
  });

  it('rejects a malformed envelope before reading any signer key', async () => {
    const run = await openGate();
    const failure = await failureOf(
      run.acts.verifyApproval({ envelope: { not: 'an envelope' }, gate: run.gate }),
    );
    expect(failure).toMatchObject({ type: 'ApprovalRejected', nonRetryable: true });
    expect(failure instanceof Error ? failure.message : '').toContain('malformed');
  });

  it('refuses to evaluate or open a gate before the earlier results are stored', async () => {
    const acts = activities();
    const runId = newRunId('early');
    const { taskId } = await acts.createTaskAndRun({ runId, goal: GOAL, constraints });

    expect(await failureOf(acts.runBusinessOwner({ runId, taskId, constraints }))).toMatchObject({
      type: 'MissingInput',
      nonRetryable: true,
    });
    expect(await failureOf(acts.openReviewGate({ runId, taskId }))).toMatchObject({
      type: 'GateNotReady',
      nonRetryable: true,
    });
  });

  it('computes the gate digest from the payload for a result stored without a digest', async () => {
    const acts = activities();
    const runId = newRunId('legacy');
    const { taskId } = await acts.createTaskAndRun({ runId, goal: GOAL, constraints });
    const payload = { legacy: true };
    for (const [resultId, kind] of [
      [researchResultId(runId), 'research-proposal'],
      [`${runId}-business-evaluation`, 'business-evaluation'],
    ] as const) {
      await env.repo.insertResult({
        resultId,
        taskId,
        runId,
        kind,
        producedBy: 'mock',
        payload,
        createdAt: new Date().toISOString(),
      });
    }

    const gate = await acts.openReviewGate({ runId, taskId });

    expect(gate.artifacts.map((artifact) => artifact.digest)).toEqual([
      digestPayload(payload),
      digestPayload(payload),
    ]);
  });
});
