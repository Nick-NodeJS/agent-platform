import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Client, Connection } from '@temporalio/client';
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
  type AgentExecutor,
  type AgentRunRequest,
  type AgentRunResponse,
  type ApprovalPayload,
  type DecisionAck,
  type WorkflowStatus,
  type ResourceConstraints,
} from '@platform/contracts';
import {
  generateSigner,
  signApproval,
  type SignerFile,
  type TrustedSigner,
} from '@platform/contracts/node';
import { LocalTaskStore, MockAgentExecutor } from '@platform/integrations';
import { createPool, migrate, RunRepository, type Db } from '@platform/persistence';
import { createActivities, type ActivityDeps } from '../../apps/worker/src/activities.js';

if (process.env['DATABASE_URL'] === undefined) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env */
  }
}

const workflowsPath = fileURLToPath(
  new URL('../../apps/worker/dist/workflows/index.js', import.meta.url),
);

/** Counts real executor invocations, optionally slowed/blocked, around the deterministic mock. */
export class CountingExecutor implements AgentExecutor {
  readonly calls: AgentRunRequest<unknown>[] = [];
  gate: Promise<void> | undefined;
  delayMs = 0;
  private readonly inner = new MockAgentExecutor();
  async run<I, O>(request: AgentRunRequest<I>): Promise<AgentRunResponse<O>> {
    this.calls.push(request as AgentRunRequest<unknown>);
    if (this.gate) await this.gate;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.run<I, O>(request);
  }
  count(role?: string) {
    return this.calls.filter((c) => !role || c.role === role).length;
  }
}

export interface Env {
  adminUrl: string;
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
  if (!base)
    throw new Error('DATABASE_URL is required (copy .env.example to .env and run pnpm infra:up)');
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
  wrap?: (acts: ReturnType<typeof createActivities>) => Record<string, (...a: never[]) => unknown>,
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

export const constraints: ResourceConstraints = {
  budgetUsd: 'unknown',
  teamSize: 'unknown',
  timelineWeeks: 'unknown',
  notes: 'unknown',
};

export const newRunId = (prefix = 'it') => `${prefix}-${randomUUID().slice(0, 10)}`;

export async function startRun(env: Env, runId = newRunId()) {
  await env.client.workflow.start(WORKFLOW_NAME, {
    workflowId: runId,
    taskQueue: env.taskQueue,
    args: [{ runId, goal: 'integration test goal', constraints }],
  });
  return runId;
}

export const query = (env: Env, runId: string) =>
  env.client.workflow.getHandle(runId).query<WorkflowStatus>(STATUS_QUERY);

export async function waitForStatus(
  env: Env,
  runId: string,
  pred: (s: WorkflowStatus) => boolean,
  ms = 30000,
) {
  const end = Date.now() + ms;
  let last: WorkflowStatus | undefined;
  while (Date.now() < end) {
    try {
      last = await query(env, runId);
      if (pred(last)) return last;
    } catch {
      /* worker not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting on ${runId}; last=${JSON.stringify(last)}`);
}

export const waitForGate = (env: Env, runId: string) => waitForStatus(env, runId, (s) => !!s.gate);

export function sign(
  env: Env,
  wf: WorkflowStatus,
  patch: Partial<ApprovalPayload> = {},
  signer: SignerFile = env.signer,
) {
  const issued = Date.now();
  const payload: ApprovalPayload = {
    version: 1,
    decisionId: `dec-${randomUUID().slice(0, 12)}`,
    runId: wf.runId,
    gateId: wf.gate!.gateId,
    artifacts: wf.gate!.artifacts,
    decision: 'approve',
    keyId: signer.keyId,
    actor: signer.actor,
    issuedAt: new Date(issued - 1000).toISOString(),
    expiresAt: new Date(issued + 5 * 60_000).toISOString(),
    ...patch,
  };
  return signApproval(payload, signer);
}

export const submit = (env: Env, runId: string, envelope: unknown) =>
  env.client.workflow.getHandle(runId).executeUpdate<DecisionAck, [unknown]>(DECISION_UPDATE, {
    args: [envelope],
  });

export async function expectRejected(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error('expected the decision to be rejected, but it was accepted');
  const msg = String(
    (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message,
  );
  if (!pattern.test(msg)) throw new Error(`rejected with unexpected message: ${msg}`);
}

export async function terminateQuietly(env: Env, runId: string) {
  await env.client.workflow
    .getHandle(runId)
    .terminate('integration test cleanup')
    .catch(() => undefined);
}
