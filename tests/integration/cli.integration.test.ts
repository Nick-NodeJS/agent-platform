import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { platformConstraintsSchema } from '@platform/contracts';
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
const READ_EXECUTE_ONLY_MODE = 0o500;
const OWNER_ALL_MODE = 0o700;
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
    expect((await cli(['start', '--goal', 'g', '--build-budget-usd', 'lots'])).err).toContain(
      'build-budget-usd must be a number',
    );
    expect((await cli(['start', '--goal', 'g', '--team-size', '2'])).err).toContain(
      '--team-size: it was removed',
    );
    expect((await cli(['start', '--goal', 'g', '--budget-usd', '5'])).err).toContain(
      'use --build-budget-usd',
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
      '--build-budget-usd',
      '40',
      '--launch-deadline-weeks',
      '3',
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

  it('start applies the constraints file, lets flags override it, and the platform flags a proposal that breaks the limits', async () => {
    const file = path.join(env.keyDir, 'constraints.json');
    await writeFile(
      file,
      JSON.stringify({ limits: { buildBudgetUsd: 12, launchDeadlineWeeks: 6 } }),
    );
    const runId = newRunId('cli');
    startedRuns.push(runId);

    const started = await cli([
      'start',
      '--goal',
      'limits goal',
      '--run-id',
      runId,
      '--constraints-file',
      file,
      '--monthly-run-cap-usd',
      '9',
    ]);
    expect(started.code).toBe(0);
    await waitForGate(env, runId);

    const stored = await env.db.query('SELECT constraints FROM runs WHERE run_id=$1', [runId]);
    const constraints = platformConstraintsSchema.parse(
      z.object({ constraints: z.unknown() }).parse(stored.rows[0]).constraints,
    );
    expect(constraints.limits).toMatchObject({
      buildBudgetUsd: 12,
      monthlyRunCapUsd: 9,
      launchDeadlineWeeks: 6,
      minimumMonthlyMarginUsd: 'unknown',
    });
    // The fictional proposal costs 30 to build, over the 12 limit: the platform's check fails and the owner does not proceed.
    const status = await cli(['status', runId]);
    expect(status.out).toContain('"recommendation":"do-not-proceed"');
    expect(status.out).toContain('"rule":"build-budget","status":"fail"');
  });

  it('start refuses an unusable constraints file instead of falling back to defaults', async () => {
    const broken = path.join(env.keyDir, 'broken-constraints.json');
    await writeFile(broken, '{"limits":{"buildBudgetUsd":-5}}');

    const invalid = await cli(['start', '--goal', 'g', '--constraints-file', broken]);
    const missing = await cli([
      'start',
      '--goal',
      'g',
      '--constraints-file',
      path.join(env.keyDir, 'none.json'),
    ]);

    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('cannot use constraints file');
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('cannot use constraints file');
  });

  it('says so when the task file cannot be found, instead of silently showing no results', async () => {
    const runId = newRunId('cli');
    startedRuns.push(runId);
    await cli(['start', '--goal', 'CLI goal missing file', '--run-id', runId]);
    await waitForGate(env, runId);
    await rm(path.join(env.tasksDir, `task-${runId}.json`));

    const missing = await cli(['status', runId]);

    expect(missing.code).toBe(0);
    expect(missing.out).toContain(`task-${runId}.json (not found: check TASK_STORE_DIR`);
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
    expect(healthy.out).toContain(`ok   task store directory writable (${env.tasksDir})`);
    expect(healthy.out).toContain('ok   EXECUTION_MODE (mock)');
    expect(healthy.out).toContain('ok   approval trusted signers readable');
    expect(healthy.out).toContain('present (human CLI only)');
    expect(healthy.out).not.toContain('PRIVATE KEY');

    const broken = await cli(['doctor'], {
      TEMPORAL_ADDRESS: UNREACHABLE_TEMPORAL,
      DATABASE_URL: '',
      EXECUTION_MODE: 'openhands',
      APPROVAL_SIGNER_FILE: path.join(env.keyDir, 'nowhere', 'signer.json'),
    });
    expect(broken.code).toBe(1);
    expect(broken.out).toContain('FAIL temporal reachable');
    expect(broken.out).toContain(
      'FAIL EXECUTION_MODE (openhands: real execution is not implemented',
    );
    expect(broken.out).toContain('FAIL approval trusted signers configured');
    expect(broken.out).toContain('FAIL DATABASE_URL set');
    expect(broken.out).toContain('not found; only needed on the machine where a human approves');

    await mkdir(path.join(env.keyDir, 'x'), { recursive: true });
    const unreadable = await cli(['doctor'], {
      APPROVAL_TRUSTED_SIGNERS_FILE: path.join(env.keyDir, 'x'),
    });
    expect(unreadable.out).toContain('FAIL approval trusted signers readable');
  });

  it.skipIf(process.getuid?.() === 0)(
    'doctor flags a task store directory that cannot be created',
    async () => {
      const readOnly = path.join(env.keyDir, 'read-only');
      await mkdir(readOnly, { recursive: true });
      await chmod(readOnly, READ_EXECUTE_ONLY_MODE);
      try {
        const result = await cli(['doctor'], { TASK_STORE_DIR: path.join(readOnly, 'tasks') });

        expect(result.out).toContain('FAIL task store directory writable');
        expect(result.code).toBe(1);
      } finally {
        await chmod(readOnly, OWNER_ALL_MODE);
      }
    },
  );
});
