import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import {
  Client,
  Connection,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  WorkflowUpdateFailedError,
} from '@temporalio/client';
import {
  NativeConnection,
  Worker,
  bundleWorkflowCode,
  type WorkflowBundle,
} from '@temporalio/worker';
import {
  WORKFLOW_NAME,
  STATUS_QUERY,
  DECISION_UPDATE,
  approvalSchema,
  decisionAckSchema,
  resultSchema,
  taskSchema,
  workflowStatusSchema,
  type AgentExecutor,
  type AgentRoleIO,
  type AgentRunRequest,
  type AgentRunResponse,
  type ExecutableRole,
  type ApprovalPayload,
  type WorkflowStatus,
  type ResourceConstraints,
  type ReviewGate,
} from '@platform/contracts';
import {
  generateSigner,
  signApproval,
  type SignerFile,
  type TrustedSigner,
} from '@platform/contracts/node';
import { LocalTaskStore, MockAgentExecutor } from '@platform/integrations';
import type { CliContext } from '../../apps/cli/src/context.js';
import { createPool, migrate, RunRepository, type Db } from '@platform/persistence';
import {
  createActivities,
  type Activities,
  type ActivityDeps,
} from '../../apps/worker/src/activities.js';

if (process.env['DATABASE_URL'] === undefined && existsSync('.env')) {
  process.loadEnvFile('.env');
}

const workflowsPath = fileURLToPath(
  new URL('../../apps/worker/dist/workflows/index.js', import.meta.url),
);

/** Counts real executor invocations around the deterministic mock; can be slowed, blocked or made to fail. */
export class CountingExecutor implements AgentExecutor {
  readonly calls: AgentRunRequest[] = [];
  /** Holds every call until it resolves (models a slow external run). */
  gate: Promise<void> | undefined;
  delayMs = 0;
  /** When set, calls are counted and then fail with this error. */
  failure: Error | undefined;
  private readonly inner = new MockAgentExecutor();

  async run<R extends ExecutableRole>(
    request: AgentRunRequest<R>,
  ): Promise<AgentRunResponse<AgentRoleIO[R]['output']>> {
    this.calls.push(request);
    await this.gate;
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }
    if (this.failure) {
      throw this.failure;
    }
    return this.inner.run(request);
  }

  count(role?: ExecutableRole): number {
    return this.calls.filter((call) => !role || call.role === role).length;
  }
}

export interface Env {
  adminUrl: string;
  databaseUrl: string;
  dbName: string;
  db: Db;
  repo: RunRepository;
  tasksDir: string;
  tasks: LocalTaskStore;
  keyDir: string;
  trustedFile: string;
  signer: SignerFile;
  trusted: TrustedSigner;
  bundle: WorkflowBundle;
  temporal: Connection;
  client: Client;
  taskQueue: string;
  cleanup: () => Promise<void>;
}

export async function createEnv(): Promise<Env> {
  const base = process.env['DATABASE_URL'];
  if (!base) {
    throw new Error('DATABASE_URL is required (copy .env.example to .env and run pnpm infra:up)');
  }
  const url = new URL(base);
  const dbName = `platform_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  url.pathname = `/${dbName}`;
  const db = createPool(url.toString());
  await migrate(db);

  const tasksDir = await mkdtemp(path.join(os.tmpdir(), 'it-tasks-'));
  const keyDir = await mkdtemp(path.join(os.tmpdir(), 'it-keys-'));
  const { signer, trusted } = generateSigner('it-key', 'it-human');
  const trustedFile = path.join(keyDir, 'trusted-signers.json');
  writeFileSync(trustedFile, JSON.stringify([trusted]));

  const bundle = await bundleWorkflowCode({ workflowsPath });
  const address = process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233';
  const temporal = await Connection.connect({ address });
  const client = new Client({ connection: temporal });
  const taskQueue = `it-${randomUUID().slice(0, 8)}`;

  return {
    adminUrl: adminUrl.toString(),
    databaseUrl: url.toString(),
    dbName,
    db,
    repo: new RunRepository(db),
    tasksDir,
    tasks: new LocalTaskStore({ rootDir: tasksDir }),
    keyDir,
    trustedFile,
    signer,
    trusted,
    bundle,
    temporal,
    client,
    taskQueue,
    cleanup: async () => {
      await temporal.close();
      await db.end();
      const adm = new pg.Client({ connectionString: adminUrl.toString() });
      await adm.connect();
      await adm.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await adm.end();
      await rm(tasksDir, { recursive: true, force: true });
      await rm(keyDir, { recursive: true, force: true });
    },
  };
}

export interface RunningWorker {
  stop: () => Promise<void>;
}

export async function startWorker(
  env: Env,
  overrides: Partial<ActivityDeps> = {},
  wrap?: (activities: Activities) => Activities,
): Promise<RunningWorker> {
  const connection = await NativeConnection.connect({
    address: process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233',
  });
  const acts = createActivities({
    repo: env.repo,
    tasks: env.tasks,
    executor: new MockAgentExecutor(),
    trustedSignersFile: env.trustedFile,
    leaseTtlMs: 5000,
    ...overrides,
  });
  const worker = await Worker.create({
    connection,
    taskQueue: env.taskQueue,
    workflowBundle: env.bundle,
    activities: wrap ? wrap(acts) : acts,
    shutdownGraceTime: '2s',
  });
  const running = worker.run();
  return {
    stop: async () => {
      worker.shutdown();
      await running;
      await connection.close();
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const constraints: ResourceConstraints = {
  budgetUsd: 'unknown',
  teamSize: 'unknown',
  timelineWeeks: 'unknown',
  notes: 'unknown',
};

export const newRunId = (prefix = 'it') => `${prefix}-${randomUUID().slice(0, 10)}`;

/** Starts a run exactly like the CLI does: only a failed (undecided) execution of the same id may be restarted. */
export async function startRun(env: Env, runId = newRunId()) {
  await env.client.workflow.start(WORKFLOW_NAME, {
    workflowId: runId,
    taskQueue: env.taskQueue,
    args: [{ runId, goal: 'integration test goal', constraints }],
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
  });
  return runId;
}

/** Starts a new execution with an explicitly permissive reuse policy, as a caller bypassing the CLI could. */
export function startRunBypassingCli(env: Env, runId: string) {
  return env.client.workflow.start(WORKFLOW_NAME, {
    workflowId: runId,
    taskQueue: env.taskQueue,
    args: [{ runId, goal: 'bypass attempt', constraints }],
    workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
  });
}

const POLL_INTERVAL_MS = 150;
const DEFAULT_WAIT_MS = 30_000;
const APPROVAL_VALIDITY_MS = 5 * 60_000;
const BACKDATE_MS = 1000;

export async function query(env: Env, runId: string): Promise<WorkflowStatus> {
  const raw = await env.client.workflow.getHandle(runId).query(STATUS_QUERY);
  return workflowStatusSchema.parse(raw);
}

/** Bounded polling: a worker that is still starting makes the query fail, which is retried until the deadline. */
export async function waitForStatus(
  env: Env,
  runId: string,
  predicate: (status: WorkflowStatus) => boolean,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<WorkflowStatus> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowStatus | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await query(env, runId);
      if (predicate(last)) {
        return last;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timeout waiting on ${runId}; last status=${JSON.stringify(last)}; last query error=${String(lastError)}`,
  );
}

/** Bounded wait for a condition that is not exposed through the workflow status (e.g. an executor was called). */
export async function waitUntil(
  condition: () => boolean,
  description: string,
  timeoutMs = DEFAULT_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting until ${description}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export const waitForGate = (env: Env, runId: string) =>
  waitForStatus(env, runId, (status) => status.gate !== undefined);

/** Builds a signed decision for the gate shown in `status`; `patch` overrides signed fields to craft bad inputs. */
export function sign(
  env: Env,
  status: WorkflowStatus,
  patch: Partial<ApprovalPayload> = {},
  signer: SignerFile = env.signer,
) {
  if (!status.gate) {
    throw new Error('cannot sign: the run has no open review gate');
  }
  return signForGate(status.gate, patch, signer);
}

export function signForGate(
  gate: ReviewGate,
  patch: Partial<ApprovalPayload> = {},
  signer: SignerFile,
) {
  const issuedAt = Date.now();
  const payload: ApprovalPayload = {
    version: 1,
    decisionId: `dec-${randomUUID().slice(0, 12)}`,
    runId: gate.runId,
    gateId: gate.gateId,
    artifacts: gate.artifacts,
    decision: 'approve',
    keyId: signer.keyId,
    actor: signer.actor,
    issuedAt: new Date(issuedAt - BACKDATE_MS).toISOString(),
    expiresAt: new Date(issuedAt + APPROVAL_VALIDITY_MS).toISOString(),
    ...patch,
  };
  return signApproval(payload, signer);
}

export async function submit(env: Env, runId: string, envelope: unknown) {
  const raw = await env.client.workflow
    .getHandle(runId)
    .executeUpdate(DECISION_UPDATE, { args: [envelope] });
  return decisionAckSchema.parse(raw);
}

export function failureMessage(error: unknown): string {
  if (error instanceof WorkflowUpdateFailedError) {
    return error.cause?.message ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Asserts that a decision was refused with a reason matching `pattern`. */
export async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  if (!outcome) {
    throw new Error('expected the decision to be rejected, but it was accepted');
  }
  const message = failureMessage(outcome.error);
  if (!pattern.test(message)) {
    throw new Error(`rejected with unexpected message: ${message}`);
  }
}

export async function terminateQuietly(env: Env, runId: string): Promise<void> {
  await env.client.workflow
    .getHandle(runId)
    .terminate('integration test cleanup')
    .catch((error: unknown) => {
      // Already-completed workflows cannot be terminated; that is the normal case for finished runs.
      if (!/not found|already completed/i.test(failureMessage(error))) {
        throw error;
      }
    });
}

const taskFileSchema = z.object({
  task: taskSchema,
  results: z.array(resultSchema),
  approvals: z.array(approvalSchema),
});

/** Reads the canonical JSON task file written by the LocalTaskStore for `runId`. */
export async function readTaskFile(env: Env, runId: string) {
  const raw = await readFile(path.join(env.tasksDir, `task-${runId}.json`), 'utf8');
  return taskFileSchema.parse(JSON.parse(raw));
}

const approvalRowSchema = z.object({
  decision: z.string(),
  source: z.string(),
  actor: z.string(),
  key_id: z.string(),
  decision_id: z.string(),
});

/** Persisted approval rows of a run, as the Postgres source of truth sees them. */
export async function approvalRows(env: Env, runId: string) {
  const found = await env.db.query(
    'SELECT decision, source, actor, key_id, decision_id FROM approvals WHERE run_id=$1',
    [runId],
  );
  return found.rows.map((row) => approvalRowSchema.parse(row));
}

const resultIdRowSchema = z.object({ result_id: z.string() });

export async function resultIds(env: Env, runId: string): Promise<string[]> {
  const found = await env.db.query('SELECT result_id FROM results WHERE run_id=$1', [runId]);
  return found.rows.map((row) => resultIdRowSchema.parse(row).result_id);
}

/** A CLI context bound to the temporary test infrastructure, capturing everything the CLI prints. */
export function cliContext(env: Env, overrides: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: {
      DATABASE_URL: env.databaseUrl,
      TEMPORAL_ADDRESS: process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233',
      TASK_QUEUE: env.taskQueue,
      TASK_STORE_DIR: env.tasksDir,
      ...overrides,
    },
    cwd: process.cwd(),
    homeDir: env.keyDir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { ctx, out, err };
}
