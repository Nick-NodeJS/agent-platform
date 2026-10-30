import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { runCli } from '../../apps/cli/src/cli.js';
import {
  CountingExecutor,
  cliContext,
  createEnv,
  newRunId,
  startWorker,
  terminateQuietly,
  waitForGate,
  waitForStatus,
  waitUntil,
  type Env,
  type RunningWorker,
} from './harness.js';

const OWNER_ONLY_MODE = 0o600;
const UNREACHABLE_TEMPORAL = '127.0.0.1:1';

describe('CLI commands against live Temporal + Postgres', () => {
  let env: Env;
  let worker: RunningWorker;
  let executor: CountingExecutor;
  let releaseResearch = () => {};
  let signerFile: string;
  const startedRuns: string[] = [];

  /** Runs one CLI invocation in-process and returns its exit code and captured output. */
  const cli = async (argv: string[], overrides: NodeJS.ProcessEnv = {}) => {
    const { ctx, out, err } = cliContext(env, { APPROVAL_SIGNER_FILE: signerFile, ...overrides });
    const code = await runCli(argv, ctx);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  beforeAll(async () => {
    env = await createEnv();
    const keyDir = path.join(env.keyDir, 'cli-keys');
    signerFile = path.join(keyDir, 'signer.json');
    const keygen = await cli([
      'approval-keygen',
      '--actor',
      'cli-human',
      '--key-id',
      'cli-key',
      '--dir',
      keyDir,
    ]);
    expect(keygen.code).toBe(0);

    executor = new CountingExecutor();
    executor.gate = new Promise<void>((resolve) => {
      releaseResearch = resolve;
    });
    worker = await startWorker(env, {
      executor,
      trustedSignersFile: path.join(keyDir, 'trusted-signers.json'),
    });
  });

  afterAll(async () => {
    releaseResearch();
    for (const runId of startedRuns) {
      await terminateQuietly(env, runId);
    }
    await worker?.stop();
    await env?.cleanup();
  });

  it('prints usage, and reports bad input as an error exit code instead of crashing', async () => {
    expect((await cli([])).out).toContain('Usage: agent-platform');
    expect((await cli([])).code).toBe(0);
    expect((await cli(['frobnicate'])).code).toBe(1);
    expect((await cli(['start', '--goal'])).err).toContain('missing value for --goal');
    expect((await cli(['start'])).err).toContain('--goal is required');
    expect((await cli(['start', '--goal', 'g', '--budget-usd', 'lots'])).err).toContain(
      'budget-usd must be a number',
    );
    expect((await cli(['status'])).err).toContain('runId required');
    expect((await cli(['status', '../escape'])).code).toBe(1);
  });

  it('key generation is explicit, owner-only, never inside the repo, and never overwrites', async () => {
    const mode = (await stat(signerFile)).mode & 0o777;
    expect(mode).toBe(OWNER_ONLY_MODE);

    const again = await cli(['approval-keygen', '--actor', 'x', '--dir', path.dirname(signerFile)]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('refusing to overwrite');

    const insideRepo = await cli(['approval-keygen', '--actor', 'x', '--dir', 'keys-in-repo']);
    expect(insideRepo.code).toBe(1);
    expect(insideRepo.err).toContain('inside the repository');

    const noActor = await cli(['approval-keygen']);
    expect(noActor.err).toContain('--actor is required');

    const defaultDirKeys = await cli(['approval-keygen', '--actor', 'default-dir']);
    expect(defaultDirKeys.code).toBe(0);
    expect(defaultDirKeys.out).toContain(
      path.join(env.keyDir, '.config', 'agent-platform', 'approval'),
    );
  });

  it('refuses to approve before the gate is open, then approves, and treats repeats as no-ops', async () => {
    const runId = newRunId('cli');
    startedRuns.push(runId);
    const started = await cli([
      'start',
      '--goal',
      'CLI goal',
      '--run-id',
      runId,
      '--budget-usd',
      '100',
      '--team-size',
      '2',
      '--timeline-weeks',
      '4',
      '--notes',
      'n',
    ]);
    expect(started.code).toBe(0);
    expect(started.out).toContain(`started run ${runId}`);
    try {
      await waitForStatus(env, runId, (status) => status.status === 'RESEARCHING');

      const early = await cli(['approve', runId]);
      expect(early.code).toBe(1);
      expect(early.err).toContain('not ready');
      await waitUntil(() => executor.count('researcher') === 1, 'the researcher is running');

      const running = await cli(['status', runId]);
      expect(running.out).toContain('status:    RESEARCHING');
      expect(running.out).toContain(`task:      task-${runId}`);
      expect(running.out).not.toContain('gate:');
      expect(running.out).not.toContain('decision:');
    } finally {
      releaseResearch();
    }

    await waitForGate(env, runId);
    const waiting = await cli(['status', runId]);
    expect(waiting.code).toBe(0);
    expect(waiting.out).toContain('status:    WAITING_FOR_HUMAN_APPROVAL');
    expect(waiting.out).toContain('gate:      gate-');
    expect(waiting.out).toContain('postgres:  status=WAITING_FOR_HUMAN_APPROVAL results=2');

    const approved = await cli(['approve', runId, '--reason', 'looks fine']);
    expect(approved.code).toBe(0);
    expect(approved.out).toContain('final status: APPROVED');

    const repeat = await cli(['reject', runId]);
    expect(repeat.code).toBe(0);
    expect(repeat.out).toContain('already decided');

    const final = await cli(['status', runId]);
    expect(final.out).toContain('decision:  approve by cli-human (signer cli-key');
    expect(final.out).toContain('approvals=1');
  });

  it('reports a rejected decision clearly and exits non-zero', async () => {
    const runId = newRunId('cli');
    startedRuns.push(runId);
    await cli(['start', '--goal', 'CLI goal 2', '--run-id', runId]);
    await waitForGate(env, runId);

    const expired = await cli(['reject', runId, '--ttl-minutes', '0']);
    expect(expired.code).toBe(1);
    expect(expired.err).toContain('decision NOT accepted');

    const wrongSigner = await cli(['reject', runId], {
      APPROVAL_SIGNER_FILE: path.join(env.keyDir, 'missing-signer.json'),
    });
    expect(wrongSigner.code).toBe(1);

    const rejected = await cli(['reject', runId, '--reason', 'no']);
    expect(rejected.out).toContain('final status: REJECTED');
  });

  it('lists executions and guards reconciliation behind an explicit confirmation', async () => {
    const runId = newRunId('cli');
    startedRuns.push(runId);
    await cli(['start', '--goal', 'CLI goal 3', '--run-id', runId]);
    await waitForGate(env, runId);

    const listed = await cli(['executions', runId]);
    expect(listed.out).toContain(`${runId}:researcher:research  state=succeeded attempts=1`);
    expect(listed.out).toContain(`${runId}:business-owner:evaluation  state=succeeded attempts=1`);

    expect((await cli(['reconcile', runId, 'researcher'])).err).toContain(
      '--confirm-no-external-run',
    );
    expect((await cli(['reconcile', runId, 'qa', '--confirm-no-external-run'])).err).toContain(
      'role must be researcher or business-owner',
    );
    const notUncertain = await cli(['reconcile', runId, 'researcher', '--confirm-no-external-run']);
    expect(notUncertain.out).toContain('is not uncertain');
  });

  it('migrate, status of unknown runs and doctor behave', async () => {
    expect((await cli(['migrate'])).out).toContain('no pending migrations');
    expect((await cli(['status', newRunId('missing')])).code).toBe(1);

    const healthy = await cli(['doctor'], {
      APPROVAL_TRUSTED_SIGNERS_FILE: path.join(path.dirname(signerFile), 'trusted-signers.json'),
    });
    expect(healthy.code).toBe(0);
    expect(healthy.out).toContain('ok   temporal reachable');
    expect(healthy.out).toContain('ok   migrations applied');
    expect(healthy.out).toContain('ok   approval trusted signers readable');
    expect(healthy.out).toContain('present (human CLI only)');
    expect(healthy.out).not.toContain('PRIVATE KEY');

    const broken = await cli(['doctor'], {
      TEMPORAL_ADDRESS: UNREACHABLE_TEMPORAL,
      DATABASE_URL: '',
      APPROVAL_SIGNER_FILE: path.join(env.keyDir, 'nowhere', 'signer.json'),
    });
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('FAIL temporal reachable');
    expect(broken.out).toContain('FAIL approval trusted signers configured');
    expect(broken.out).toContain('FAIL DATABASE_URL set');
    expect(broken.out).toContain('not found; only needed on the machine where a human approves');

    await mkdir(path.join(env.keyDir, 'x'), { recursive: true });
    const unreadable = await cli(['doctor'], {
      APPROVAL_TRUSTED_SIGNERS_FILE: path.join(env.keyDir, 'x'),
    });
    expect(unreadable.out).toContain('FAIL approval trusted signers readable');
  });
});
