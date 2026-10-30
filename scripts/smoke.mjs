// End-to-end smoke test against local infra (pnpm infra:up && pnpm db:migrate first).
// Mock mode only: no API keys, no network beyond loopback.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

if (existsSync('.env')) process.loadEnvFile('.env');
const run = promisify(execFile);
const cliRequire = createRequire(new URL('../apps/cli/package.json', import.meta.url));
const dbRequire = createRequire(new URL('../packages/persistence/package.json', import.meta.url));
const { Client, Connection } = cliRequire('@temporalio/client');
const pg = dbRequire('pg');

const keyDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-approval-'));
const keyPath = path.join(keyDir, 'keys');
// The worker environment gets ONLY the public trusted-signers file; the private signer path goes only to the CLI.
const workerEnv = {
  ...process.env,
  APPROVAL_TRUSTED_SIGNERS_FILE: path.join(keyPath, 'trusted-signers.json'),
};
delete workerEnv.APPROVAL_SIGNER_FILE;
const cliEnv = { ...workerEnv, APPROVAL_SIGNER_FILE: path.join(keyPath, 'signer.json') };
const cli = async (...args) =>
  (await run('node', ['apps/cli/dist/main.js', ...args], { env: cliEnv })).stdout;
const cliResult = (...args) =>
  run('node', ['apps/cli/dist/main.js', ...args], { env: cliEnv }).then(
    (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
    (e) => ({ code: e.code, out: e.stdout ?? '', err: e.stderr ?? '' }),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`ok   ${msg}`);
};

let worker;
const startWorker = async () => {
  worker = spawn('node', ['apps/worker/dist/main.js'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: workerEnv,
  });
  await new Promise((resolve, reject) => {
    worker.stdout.on('data', (d) => String(d).includes('worker started') && resolve());
    worker.once('exit', (c) => reject(new Error(`worker exited early (${c})`)));
    setTimeout(() => reject(new Error('worker start timeout')), 60000);
  });
  worker.stdout.resume();
  await sleep(2000);
};
const stopWorker = async () => {
  const w = worker;
  w.removeAllListeners('exit');
  const exited = new Promise((r) => w.once('exit', r));
  w.kill('SIGTERM');
  await exited;
};

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
});
const client = new Client({ connection });
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const taskDir = process.env.TASK_STORE_DIR ?? '.task-data/tasks';
const query = async (id) => client.workflow.getHandle(id).query('getStatus');
const waitFor = async (id, status) => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await query(id)).status === status) return;
    } catch {
      /* worker may be restarting */
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${status} on ${id}`);
};

const suffix = randomUUID().slice(0, 8);
const approveId = `smoke-a-${suffix}`;
const rejectId = `smoke-r-${suffix}`;

try {
  await cli('approval-keygen', '--actor', 'smoke-human', '--key-id', 'smoke-key', '--dir', keyPath);
  await startWorker();

  await cli(
    'start',
    '--goal',
    'Smoke test goal (fictional)',
    '--run-id',
    approveId,
    '--budget-usd',
    '100',
  );
  await cli('start', '--goal', 'Smoke test goal 2 (fictional)', '--run-id', rejectId);
  await waitFor(approveId, 'WAITING_FOR_HUMAN_APPROVAL');
  await waitFor(rejectId, 'WAITING_FOR_HUMAN_APPROVAL');
  assert(true, 'workflows paused at WAITING_FOR_HUMAN_APPROVAL');

  const forged = await client.workflow
    .getHandle(approveId)
    .executeUpdate('submitDecision', {
      args: [
        {
          decisionId: 'agent-attempt',
          decision: 'approve',
          source: 'human',
          actor: 'business-owner',
        },
      ],
    })
    .then(
      () => 'accepted',
      (e) => String(e.cause?.message ?? e.message),
    );
  assert(
    /malformed/.test(forged),
    `forged unsigned "source: human" decision is rejected (${forged})`,
  );
  await sleep(1000);
  assert(
    (await query(approveId)).status === 'WAITING_FOR_HUMAN_APPROVAL',
    'forged decision does not unblock the workflow',
  );

  await stopWorker();
  await startWorker();
  const afterRestart = await query(approveId);
  assert(
    afterRestart.status === 'WAITING_FOR_HUMAN_APPROVAL',
    'workflow remains queryable after worker restart',
  );

  await cli('approve', approveId, '--reason', 'smoke');
  const dup = await cliResult('reject', approveId);
  assert(
    dup.code === 0 && /already decided/.test(dup.out),
    'duplicate decision after completion changes nothing',
  );
  await cli('reject', rejectId);

  for (const [id, expected] of [
    [approveId, 'APPROVED'],
    [rejectId, 'REJECTED'],
  ]) {
    const taskId = `task-${id}`;
    const q = await query(id);
    assert(q.status === expected, `${id} finished as ${expected}`);
    const file = JSON.parse(readFileSync(`${taskDir}/${taskId}.json`, 'utf8'));
    const runRow = (await db.query('SELECT status FROM runs WHERE run_id=$1', [id])).rows;
    const counts = {
      runs: Number(
        (await db.query('SELECT count(*) FROM runs WHERE run_id=$1', [id])).rows[0].count,
      ),
      results: Number(
        (await db.query('SELECT count(*) FROM results WHERE run_id=$1', [id])).rows[0].count,
      ),
      approvals: (await db.query('SELECT decision, source FROM approvals WHERE run_id=$1', [id]))
        .rows,
    };
    assert(
      runRow[0]?.status === expected && file.task.status === expected,
      `${id}: Postgres and task file agree on ${expected}`,
    );
    assert(
      counts.runs === 1 && counts.results === 2 && file.results.length === 2,
      `${id}: no duplicate run/result records`,
    );
    assert(
      counts.approvals.length === 1 &&
        counts.approvals[0].source === 'human' &&
        file.approvals.length === 1,
      `${id}: exactly one human approval record`,
    );
    assert(
      counts.approvals[0].decision === (expected === 'APPROVED' ? 'approve' : 'reject'),
      `${id}: decision matches final status`,
    );
  }
  console.log('SMOKE PASSED');
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null) worker.kill('SIGTERM');
  rmSync(keyDir, { recursive: true, force: true });
  await db.end();
  await connection.close();
}
