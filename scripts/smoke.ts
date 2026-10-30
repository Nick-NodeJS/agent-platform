// End-to-end smoke test against local infra (pnpm infra:up && pnpm db:migrate first).
// Mock mode only: no API keys, no network beyond loopback. Drives the real CLI and worker as separate processes.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { Client, Connection, WorkflowUpdateFailedError } from '@temporalio/client';
import { STATUS_QUERY, workflowStatusSchema, type WorkflowStatus } from '@platform/contracts';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const WAITING = 'WAITING_FOR_HUMAN_APPROVAL';
const WORKER_START_TIMEOUT_MS = 60_000;
const WORKER_SETTLE_MS = 2000;
const WAIT_ATTEMPTS = 60;
const WAIT_INTERVAL_MS = 500;
const FORGED_OBSERVATION_MS = 1000;
const CLI = 'apps/cli/dist/main.js';
const WORKER = 'apps/worker/dist/main.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`ok   ${message}`);
}

// The worker environment gets ONLY the public trusted-signers file; the private signer path goes only to the CLI.
const keyDir = mkdtempSync(path.join(os.tmpdir(), 'smoke-approval-'));
const keyPath = path.join(keyDir, 'keys');
const workerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  APPROVAL_TRUSTED_SIGNERS_FILE: path.join(keyPath, 'trusted-signers.json'),
};
delete workerEnv['APPROVAL_SIGNER_FILE'];
const cliEnv: NodeJS.ProcessEnv = {
  ...workerEnv,
  APPROVAL_SIGNER_FILE: path.join(keyPath, 'signer.json'),
};

async function cli(...args: string[]): Promise<string> {
  return (await execFileAsync('node', [CLI, ...args], { env: cliEnv })).stdout;
}

/** Runs the CLI and reports its exit code instead of throwing, for commands expected to fail. */
async function cliOutcome(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    return { code: 0, out: (await execFileAsync('node', [CLI, ...args], { env: cliEnv })).stdout };
  } catch (error) {
    const failure = z.object({ code: z.number(), stdout: z.string() }).safeParse(error);
    return {
      code: failure.success ? failure.data.code : 1,
      out: failure.success ? failure.data.stdout : '',
    };
  }
}

function updateFailureMessage(error: unknown): string {
  if (error instanceof WorkflowUpdateFailedError) {
    return error.cause?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

let worker: ChildProcess | undefined;

async function startWorker(): Promise<void> {
  const child = spawn('node', [WORKER], { stdio: ['ignore', 'pipe', 'inherit'], env: workerEnv });
  worker = child;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('worker start timeout')),
      WORKER_START_TIMEOUT_MS,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('worker started')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`worker exited early (${code})`)));
  });
  child.stdout?.resume();
  await sleep(WORKER_SETTLE_MS); // let the Temporal poller attach before the first workflow task
}

async function stopWorker(): Promise<void> {
  const child = worker;
  if (!child) {
    return;
  }
  child.removeAllListeners('exit');
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  worker = undefined;
}

const rowCountSchema = z.object({ count: z.coerce.number() });
const statusRowSchema = z.object({ status: z.string() });
const approvalRowSchema = z.object({ decision: z.string(), source: z.string() });
const taskFileSchema = z.object({
  task: z.object({ status: z.string() }),
  results: z.array(z.unknown()),
  approvals: z.array(z.unknown()),
});

async function main(): Promise<void> {
  const connection = await Connection.connect({
    address: process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233',
  });
  const client = new Client({ connection });
  const db = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
  const taskDir = process.env['TASK_STORE_DIR'] ?? '.task-data/tasks';

  const query = async (runId: string): Promise<WorkflowStatus> =>
    workflowStatusSchema.parse(await client.workflow.getHandle(runId).query(STATUS_QUERY));

  const waitFor = async (runId: string, status: string) => {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt++) {
      try {
        if ((await query(runId)).status === status) {
          return;
        }
      } catch {
        // The worker may be restarting; queries fail until it is polling again.
      }
      await sleep(WAIT_INTERVAL_MS);
    }
    throw new Error(`timeout waiting for ${status} on ${runId}`);
  };

  const suffix = randomUUID().slice(0, 8);
  const approveId = `smoke-a-${suffix}`;
  const rejectId = `smoke-r-${suffix}`;

  try {
    await cli(
      'approval-keygen',
      '--actor',
      'smoke-human',
      '--key-id',
      'smoke-key',
      '--dir',
      keyPath,
    );
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
    await waitFor(approveId, WAITING);
    await waitFor(rejectId, WAITING);
    check(true, 'workflows paused at WAITING_FOR_HUMAN_APPROVAL');

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
        (error: unknown) => updateFailureMessage(error),
      );
    check(
      /malformed/.test(forged),
      `forged unsigned "source: human" decision is rejected (${forged})`,
    );
    await sleep(FORGED_OBSERVATION_MS);
    check(
      (await query(approveId)).status === WAITING,
      'forged decision does not unblock the workflow',
    );

    await stopWorker();
    await startWorker();
    check(
      (await query(approveId)).status === WAITING,
      'workflow remains queryable after worker restart',
    );

    await cli('approve', approveId, '--reason', 'smoke');
    const duplicate = await cliOutcome('reject', approveId);
    check(
      duplicate.code === 0 && /already decided/.test(duplicate.out),
      'duplicate decision after completion changes nothing',
    );
    await cli('reject', rejectId);

    for (const [runId, expected] of [
      [approveId, 'APPROVED'],
      [rejectId, 'REJECTED'],
    ] as const) {
      check((await query(runId)).status === expected, `${runId} finished as ${expected}`);

      const taskFile = taskFileSchema.parse(
        JSON.parse(readFileSync(`${taskDir}/task-${runId}.json`, 'utf8')),
      );
      const run = await db.query('SELECT status FROM runs WHERE run_id=$1', [runId]);
      check(
        statusRowSchema.parse(run.rows[0]).status === expected && taskFile.task.status === expected,
        `${runId}: Postgres and task file agree on ${expected}`,
      );

      const runs = await db.query('SELECT count(*) FROM runs WHERE run_id=$1', [runId]);
      const results = await db.query('SELECT count(*) FROM results WHERE run_id=$1', [runId]);
      check(
        rowCountSchema.parse(runs.rows[0]).count === 1 &&
          rowCountSchema.parse(results.rows[0]).count === 2 &&
          taskFile.results.length === 2,
        `${runId}: no duplicate run/result records`,
      );

      const approvals = (
        await db.query('SELECT decision, source FROM approvals WHERE run_id=$1', [runId])
      ).rows.map((row) => approvalRowSchema.parse(row));
      check(
        approvals.length === 1 &&
          approvals[0]?.source === 'human' &&
          taskFile.approvals.length === 1,
        `${runId}: exactly one human approval record`,
      );
      check(
        approvals[0]?.decision === (expected === 'APPROVED' ? 'approve' : 'reject'),
        `${runId}: decision matches final status`,
      );
    }
    console.log('SMOKE PASSED');
  } finally {
    await stopWorker();
    await db.end();
    await connection.close();
  }
}

main()
  .catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });
