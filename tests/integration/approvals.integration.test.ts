import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { generateSigner } from '@platform/contracts/node';
import {
  CountingExecutor,
  createEnv,
  expectRejected,
  newRunId,
  query,
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

describe('review gate and signed human approval (live Temporal + Postgres)', () => {
  let env: Env;
  let worker: RunningWorker;
  const runs: string[] = [];
  const track = (id: string) => (runs.push(id), id);

  beforeAll(async () => {
    env = await createEnv();
    worker = await startWorker(env);
  });
  afterAll(async () => {
    for (const r of runs) await terminateQuietly(env, r);
    await worker?.stop();
    await env?.cleanup();
  });

  it('rejects early decisions, never buffers them, and opens the gate only after persistence', async () => {
    await worker.stop();
    const exec = new CountingExecutor();
    let release!: () => void;
    exec.gate = new Promise((r) => (release = r));
    worker = await startWorker(env, { executor: exec });

    const runId = track(await startRun(env));
    const early = await waitForStatus(env, runId, (s) => s.status === 'RESEARCHING');
    expect(early.gate).toBeUndefined();

    // A validly signed decision for an invented gate/artifacts, submitted before the gate exists.
    const fakeWf = {
      ...early,
      gate: {
        gateId: 'gate-not-yet',
        runId,
        artifacts: [{ resultId: 'x', digest: 'a'.repeat(64) }],
      },
    };
    await expectRejected(submit(env, runId, sign(env, fakeWf)), /not open yet/);

    release();
    const wf = await waitForGate(env, runId);
    // Invariant: when the gate is visible, everything it refers to is already persisted and projected.
    const row = (await env.db.query('SELECT status FROM runs WHERE run_id=$1', [runId])).rows[0];
    const results = (await env.db.query('SELECT result_id FROM results WHERE run_id=$1', [runId]))
      .rows;
    const taskFile = JSON.parse(
      readFileSync(path.join(env.tasksDir, `task-${runId}.json`), 'utf8'),
    );
    expect(row.status).toBe('WAITING_FOR_HUMAN_APPROVAL');
    expect(results).toHaveLength(2);
    expect(taskFile.task.status).toBe('WAITING_FOR_HUMAN_APPROVAL');
    expect(taskFile.results).toHaveLength(2);
    expect(wf.gate!.artifacts.map((a) => a.resultId).sort()).toEqual(
      results.map((r) => r.result_id).sort(),
    );

    // The early decision was not buffered: the run is still waiting.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await query(env, runId)).status).toBe('WAITING_FOR_HUMAN_APPROVAL');

    // A fresh decision now works.
    const ack = await submit(env, runId, sign(env, wf));
    expect(ack.accepted).toBe(true);
    await env.client.workflow.getHandle(runId).result();
    expect((await query(env, runId)).status).toBe('APPROVED');
    await worker.stop();
    worker = await startWorker(env);
  });

  it('malformed, forged, unsigned, tampered, wrong-signer, expired, stale, wrong-run and replayed decisions do nothing', async () => {
    const runA = track(await startRun(env));
    const runB = track(await startRun(env));
    const a = await waitForGate(env, runA);
    const b = await waitForGate(env, runB);

    const stranger = generateSigner('it-key', 'it-human').signer; // same ids, untrusted key
    const attempts: [string, unknown, RegExp][] = [
      ['garbage', 'approve', /malformed/],
      ['empty object', {}, /malformed/],
      [
        'forged unsigned source:human',
        { source: 'human', actor: 'x', decision: 'approve', decisionId: 'd1' },
        /malformed/,
      ],
      ['payload without signature', { payload: sign(env, a).payload }, /malformed/],
      ['bad signature', { ...sign(env, a), signature: 'AAAA' }, /signature/],
      ['wrong signer key', sign(env, a, {}, stranger), /signature/],
      [
        'unknown key id',
        sign(env, a, { keyId: 'nope' }, { ...env.signer, keyId: 'nope' }),
        /unknown signer/,
      ],
      [
        'claimed actor differs from trusted config',
        sign(env, a, { actor: 'root' }, { ...env.signer, actor: 'root' }),
        /actor/,
      ],
      [
        'altered signed content',
        (() => {
          const e = sign(env, a, { decision: 'reject' });
          return { ...e, payload: { ...e.payload, decision: 'approve' } };
        })(),
        /signature/,
      ],
      [
        'expired',
        sign(env, a, {
          issuedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          expiresAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        }),
        /expired/,
      ],
      ['wrong gate', sign(env, a, { gateId: b.gate!.gateId }), /stale\) gate|different/],
      ['other run (signed for B, sent to A)', sign(env, b), /different run/],
      [
        'stale artifact digests',
        sign(env, a, {
          artifacts: [{ ...a.gate!.artifacts[0]!, digest: 'f'.repeat(64) }, a.gate!.artifacts[1]!],
        }),
        /different artifacts/,
      ],
    ];
    for (const [name, env_, pattern] of attempts) {
      await expectRejected(submit(env, runA, env_), pattern).catch((e) => {
        throw new Error(`${name}: ${e.message}`);
      });
    }
    expect((await query(env, runA)).status).toBe('WAITING_FOR_HUMAN_APPROVAL');
    expect((await env.db.query('SELECT 1 FROM approvals WHERE run_id=$1', [runA])).rowCount).toBe(
      0,
    );

    // Correctly signed, current-gate decision works and identity comes from trusted config.
    const good = sign(env, a, { decision: 'reject', reason: 'not now' });
    await submit(env, runA, good);
    await env.client.workflow.getHandle(runA).result();
    const final = await query(env, runA);
    expect(final.status).toBe('REJECTED');
    expect(final.decision).toMatchObject({
      decision: 'reject',
      source: 'human',
      actor: 'it-human',
      keyId: 'it-key',
    });

    // Replay: reuse the consumed decisionId on run B with a fresh signature for B's gate.
    await expectRejected(
      submit(env, runB, sign(env, b, { decisionId: good.payload.decisionId })),
      /replay/,
    );
    // Replay of the exact envelope against the finished run A also fails.
    await expect(submit(env, runA, good)).rejects.toBeTruthy();
    expect((await query(env, runB)).status).toBe('WAITING_FOR_HUMAN_APPROVAL');

    // Run B can still be approved by a valid fresh decision; both outcomes persisted once.
    await submit(env, runB, sign(env, b));
    await env.client.workflow.getHandle(runB).result();
    for (const [id, decision] of [
      [runA, 'reject'],
      [runB, 'approve'],
    ] as const) {
      const rows = (
        await env.db.query(
          'SELECT decision, source, actor, key_id FROM approvals WHERE run_id=$1',
          [id],
        )
      ).rows;
      expect(rows).toEqual([{ decision, source: 'human', actor: 'it-human', key_id: 'it-key' }]);
    }
  });

  it('an approval for previous results cannot approve revised results', async () => {
    const runId = track(await startRun(env));
    const wf = await waitForGate(env, runId);
    const old = sign(env, wf);
    // Simulate a revised canonical artifact after the gate was opened.
    await env.db.query('UPDATE results SET digest=$2 WHERE result_id=$1', [
      wf.gate!.artifacts[0]!.resultId,
      'e'.repeat(64),
    ]);
    await expectRejected(submit(env, runId, old), /no longer current/);
    expect((await query(env, runId)).status).toBe('WAITING_FOR_HUMAN_APPROVAL');
  });

  it('first valid decision wins when approve and reject race; duplicates change nothing', async () => {
    const runId = track(await startRun(env));
    const wf = await waitForGate(env, runId);
    const settled = await Promise.allSettled([
      submit(env, runId, sign(env, wf, { decision: 'approve' })),
      submit(env, runId, sign(env, wf, { decision: 'reject' })),
      submit(env, runId, sign(env, wf, { decision: 'approve' })),
    ]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    await env.client.workflow.getHandle(runId).result();
    const final = await query(env, runId);
    const winner = (ok[0] as PromiseFulfilledResult<{ decision: string }>).value.decision;
    expect(final.status).toBe(winner === 'approve' ? 'APPROVED' : 'REJECTED');
    const rows = (await env.db.query('SELECT decision FROM approvals WHERE run_id=$1', [runId]))
      .rows;
    expect(rows).toEqual([{ decision: winner }]);
    // A late duplicate after completion cannot alter the outcome.
    await expect(
      submit(env, runId, sign(env, wf, { decision: winner === 'approve' ? 'reject' : 'approve' })),
    ).rejects.toBeTruthy();
    expect((await query(env, runId)).status).toBe(final.status);
  });

  it('waiting and decision processing survive a worker restart', async () => {
    const runId = track(await startRun(env));
    const wf = await waitForGate(env, runId);
    await worker.stop();

    // Submitted while no worker is running; it is processed once a worker returns.
    const pending = submit(env, runId, sign(env, wf, { decision: 'approve' }));
    await new Promise((r) => setTimeout(r, 1500));
    worker = await startWorker(env);
    const ack = await pending;
    expect(ack.decision).toBe('approve');
    await env.client.workflow.getHandle(runId).result();
    expect((await query(env, runId)).status).toBe('APPROVED');
    expect((await env.db.query('SELECT 1 FROM approvals WHERE run_id=$1', [runId])).rowCount).toBe(
      1,
    );
    expect(newRunId()).toBeTruthy();
  });
});
