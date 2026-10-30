import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { generateSigner } from '@platform/contracts/node';
import {
  CountingExecutor,
  createEnv,
  approvalRows,
  expectRejected,
  query,
  readTaskFile,
  resultIds,
  sign,
  startRun,
  startWorker,
  submit,
  terminateQuietly,
  waitForGate,
  waitForStatus,
  type Env,
  type RunningWorker,
} from './harness.js';

const WAITING = 'WAITING_FOR_HUMAN_APPROVAL';
const NOT_BUFFERED_OBSERVATION_MS = 1500;
const MINUTE_MS = 60_000;
const WORKER_DOWN_MS = 1500;
const DIGEST_A = 'a'.repeat(64);
const DIGEST_E = 'e'.repeat(64);
const DIGEST_F = 'f'.repeat(64);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('review gate and signed human approval (live Temporal + Postgres)', () => {
  let env: Env;
  let worker: RunningWorker;
  const startedRuns: string[] = [];

  const startTrackedRun = async () => {
    const runId = await startRun(env);
    startedRuns.push(runId);
    return runId;
  };

  const finish = (runId: string) => env.client.workflow.getHandle(runId).result();

  beforeAll(async () => {
    env = await createEnv();
    worker = await startWorker(env);
  });

  afterAll(async () => {
    for (const runId of startedRuns) {
      await terminateQuietly(env, runId);
    }
    await worker?.stop();
    await env?.cleanup();
  });

  it('rejects early decisions, never buffers them, and opens the gate only after persistence', async () => {
    await worker.stop();
    const executor = new CountingExecutor();
    let releaseResearch = () => {};
    executor.gate = new Promise<void>((resolve) => {
      releaseResearch = resolve;
    });
    worker = await startWorker(env, { executor });

    const runId = await startTrackedRun();
    const early = await waitForStatus(env, runId, (status) => status.status === 'RESEARCHING');
    expect(early.gate).toBeUndefined();

    // A well-formed, correctly signed decision for an invented gate, submitted before the gate exists.
    const inventedGate = {
      gateId: 'gate-not-yet',
      runId,
      artifacts: [{ resultId: 'not-yet-saved', digest: DIGEST_A }],
    };
    await expectRejected(
      submit(env, runId, sign(env, { ...early, gate: inventedGate })),
      /not open yet/,
    );

    releaseResearch();
    const status = await waitForGate(env, runId);

    // Invariant: once the gate is visible, everything it refers to is already persisted and projected.
    const run = await env.db.query('SELECT status FROM runs WHERE run_id=$1', [runId]);
    const savedResultIds = await resultIds(env, runId);
    const taskFile = await readTaskFile(env, runId);
    expect(run.rows).toEqual([{ status: WAITING }]);
    expect(savedResultIds).toHaveLength(2);
    expect(taskFile.task.status).toBe(WAITING);
    expect(taskFile.results).toHaveLength(2);
    expect(status.gate?.artifacts.map((artifact) => artifact.resultId).sort()).toEqual(
      savedResultIds.sort(),
    );

    // The early decision was not buffered: the run keeps waiting until a fresh decision arrives.
    await sleep(NOT_BUFFERED_OBSERVATION_MS);
    expect((await query(env, runId)).status).toBe(WAITING);

    const ack = await submit(env, runId, sign(env, status));
    expect(ack.accepted).toBe(true);
    await finish(runId);
    expect((await query(env, runId)).status).toBe('APPROVED');

    await worker.stop();
    worker = await startWorker(env);
  });

  it('malformed, forged, unsigned, tampered, wrong-signer, expired, stale, wrong-run and replayed decisions do nothing', async () => {
    const runA = await startTrackedRun();
    const runB = await startTrackedRun();
    const statusA = await waitForGate(env, runA);
    const statusB = await waitForGate(env, runB);
    const gateB = statusB.gate;
    const firstArtifact = statusA.gate?.artifacts[0];
    const secondArtifact = statusA.gate?.artifacts[1];
    if (!gateB || !firstArtifact || !secondArtifact) {
      throw new Error('both runs must have a gate with two artifacts');
    }

    const untrustedKey = generateSigner('it-key', 'it-human').signer; // same ids, key not in the trusted file
    const tampered = (() => {
      const envelope = sign(env, statusA, { decision: 'reject' });
      return { ...envelope, payload: { ...envelope.payload, decision: 'approve' } };
    })();
    const now = Date.now();

    const badDecisions: [string, unknown, RegExp][] = [
      ['garbage', 'approve', /malformed/],
      ['empty object', {}, /malformed/],
      [
        'forged unsigned "source: human"',
        { source: 'human', actor: 'x', decision: 'approve', decisionId: 'd1' },
        /malformed/,
      ],
      ['payload without signature', { payload: sign(env, statusA).payload }, /malformed/],
      ['bad signature', { ...sign(env, statusA), signature: 'AAAA' }, /signature/],
      ['untrusted key with trusted ids', sign(env, statusA, {}, untrustedKey), /signature/],
      [
        'unknown key id',
        sign(env, statusA, { keyId: 'nope' }, { ...env.signer, keyId: 'nope' }),
        /unknown signer/,
      ],
      [
        'actor that differs from the trusted signer config',
        sign(env, statusA, { actor: 'root' }, { ...env.signer, actor: 'root' }),
        /actor/,
      ],
      ['altered signed content', tampered, /signature/],
      [
        'expired',
        sign(env, statusA, {
          issuedAt: new Date(now - 12 * MINUTE_MS).toISOString(),
          expiresAt: new Date(now - 6 * MINUTE_MS).toISOString(),
        }),
        /expired/,
      ],
      ['wrong gate', sign(env, statusA, { gateId: gateB.gateId }), /different/],
      ['signed for another run', sign(env, statusB), /different run/],
      [
        'stale artifact digest',
        sign(env, statusA, {
          artifacts: [{ ...firstArtifact, digest: DIGEST_F }, secondArtifact],
        }),
        /different artifacts/,
      ],
    ];
    for (const [name, decision, reason] of badDecisions) {
      await expectRejected(submit(env, runA, decision), reason).catch((error: unknown) => {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    expect((await query(env, runA)).status).toBe(WAITING);
    expect(await approvalRows(env, runA)).toHaveLength(0);

    // A correctly signed decision for the current gate works; identity comes from the trusted config.
    const good = sign(env, statusA, { decision: 'reject', reason: 'not now' });
    await submit(env, runA, good);
    await finish(runA);
    const final = await query(env, runA);
    expect(final.status).toBe('REJECTED');
    expect(final.decision).toMatchObject({
      decision: 'reject',
      source: 'human',
      actor: 'it-human',
      keyId: 'it-key',
    });

    // Replay: the consumed decision id cannot be reused, even with a fresh signature for another run's gate.
    await expectRejected(
      submit(env, runB, sign(env, statusB, { decisionId: good.payload.decisionId })),
      /replay/,
    );
    await expect(submit(env, runA, good)).rejects.toThrow();
    expect((await query(env, runB)).status).toBe(WAITING);

    await submit(env, runB, sign(env, statusB));
    await finish(runB);
    expect(await approvalRows(env, runA)).toMatchObject([
      { decision: 'reject', source: 'human', actor: 'it-human', key_id: 'it-key' },
    ]);
    expect(await approvalRows(env, runB)).toMatchObject([
      { decision: 'approve', source: 'human', actor: 'it-human', key_id: 'it-key' },
    ]);
  });

  it('an approval for previous results cannot approve revised results', async () => {
    const runId = await startTrackedRun();
    const status = await waitForGate(env, runId);
    const firstArtifact = status.gate?.artifacts[0];
    if (!firstArtifact) {
      throw new Error('gate has no artifacts');
    }
    const approvalForOldResults = sign(env, status);

    // Simulate a revised canonical artifact after the gate was opened.
    await env.db.query('UPDATE results SET digest=$2 WHERE result_id=$1', [
      firstArtifact.resultId,
      DIGEST_E,
    ]);

    await expectRejected(submit(env, runId, approvalForOldResults), /no longer current/);
    expect((await query(env, runId)).status).toBe(WAITING);
  });

  it('the first valid decision wins when approve and reject race; later duplicates change nothing', async () => {
    const runId = await startTrackedRun();
    const status = await waitForGate(env, runId);

    const outcomes = await Promise.allSettled([
      submit(env, runId, sign(env, status, { decision: 'approve' })),
      submit(env, runId, sign(env, status, { decision: 'reject' })),
      submit(env, runId, sign(env, status, { decision: 'approve' })),
    ]);

    const accepted = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    expect(accepted).toHaveLength(1);
    const winner = accepted[0]?.decision;
    await finish(runId);
    expect((await query(env, runId)).status).toBe(winner === 'approve' ? 'APPROVED' : 'REJECTED');
    expect(await approvalRows(env, runId)).toMatchObject([
      { decision: winner, source: 'human', actor: 'it-human', key_id: 'it-key' },
    ]);

    const opposite = winner === 'approve' ? 'reject' : 'approve';
    await expect(submit(env, runId, sign(env, status, { decision: opposite }))).rejects.toThrow();
    expect((await query(env, runId)).status).toBe(winner === 'approve' ? 'APPROVED' : 'REJECTED');
  });

  it('waiting and decision processing survive a worker restart', async () => {
    const runId = await startTrackedRun();
    const status = await waitForGate(env, runId);
    await worker.stop();

    // Submitted while no worker is running; it is processed once a worker returns.
    const pending = submit(env, runId, sign(env, status, { decision: 'approve' }));
    await sleep(WORKER_DOWN_MS);
    worker = await startWorker(env);

    expect((await pending).decision).toBe('approve');
    await finish(runId);
    expect((await query(env, runId)).status).toBe('APPROVED');
    expect(await approvalRows(env, runId)).toHaveLength(1);
  });

  it('cannot verify any decision when the trusted-signer file is not configured or unreadable', async () => {
    const runId = await startTrackedRun();
    const status = await waitForGate(env, runId);

    await worker.stop();
    worker = await startWorker(env, { trustedSignersFile: undefined });
    await expectRejected(submit(env, runId, sign(env, status)), /not configured/);

    await worker.stop();
    worker = await startWorker(env, { trustedSignersFile: path.join(env.keyDir, 'missing.json') });
    await expectRejected(submit(env, runId, sign(env, status)), /unreadable or invalid/);
    expect((await query(env, runId)).status).toBe(WAITING);
    expect(await approvalRows(env, runId)).toHaveLength(0);

    await worker.stop();
    worker = await startWorker(env);
    await submit(env, runId, sign(env, status));
    await finish(runId);
  });
});
