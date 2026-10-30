import { existsSync } from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import {
  DECISION_SIGNAL,
  STATUS_QUERY,
  WORKFLOW_NAME,
  idSchema,
  loadBaseConfig,
  loadConfig,
  resourceConstraintsSchema,
  type DecisionSignal,
  type ResearchProposalInput,
  type WorkflowStatus,
} from '@platform/contracts';
import { LocalTaskStore } from '@platform/integrations';
import { createPool, migrate, RunRepository } from '@platform/persistence';

if (existsSync('.env')) process.loadEnvFile('.env');

const USAGE = `Usage: agent-platform <command>

  start --goal <text> [--run-id <id>] [--budget-usd <n>] [--team-size <n>] [--timeline-weeks <n>] [--notes <text>]
  status <runId>
  approve <runId> [--actor <name>] [--reason <text>]
  reject <runId> [--actor <name>] [--reason <text>]
  migrate
  doctor
`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${a}`);
      flags[a.slice(2)] = value;
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function temporalClient() {
  const cfg = loadBaseConfig();
  const connection = await Connection.connect({ address: cfg.TEMPORAL_ADDRESS });
  return { client: new Client({ connection, namespace: cfg.TEMPORAL_NAMESPACE }), cfg, connection };
}

const num = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

async function start(flags: Record<string, string>) {
  const goal = flags['goal'];
  if (!goal) throw new Error('--goal is required');
  const runId = idSchema.parse(flags['run-id'] ?? `run-${randomUUID().slice(0, 12)}`);
  const constraints = resourceConstraintsSchema.parse({
    ...(flags['budget-usd'] !== undefined && { budgetUsd: num(flags['budget-usd'], 'budget-usd') }),
    ...(flags['team-size'] !== undefined && { teamSize: num(flags['team-size'], 'team-size') }),
    ...(flags['timeline-weeks'] !== undefined && {
      timelineWeeks: num(flags['timeline-weeks'], 'timeline-weeks'),
    }),
    ...(flags['notes'] !== undefined && { notes: flags['notes'] }),
  });
  const { client, cfg, connection } = await temporalClient();
  const input: ResearchProposalInput = { runId, goal, constraints };
  await client.workflow.start(WORKFLOW_NAME, {
    workflowId: runId,
    taskQueue: cfg.TASK_QUEUE,
    args: [input],
  });
  await connection.close();
  console.log(`started run ${runId}`);
  console.log(`status:  pnpm cli status ${runId}`);
  console.log(
    `temporal UI: http://127.0.0.1:8233/namespaces/${cfg.TEMPORAL_NAMESPACE}/workflows/${runId}`,
  );
}

async function status(runId: string) {
  idSchema.parse(runId);
  const cfg = loadConfig();
  const { client, connection } = await temporalClient();
  const handle = client.workflow.getHandle(runId);
  const desc = await handle.describe();
  const wf = await handle.query<WorkflowStatus>(STATUS_QUERY);
  await connection.close();
  const tasks = new LocalTaskStore({ rootDir: cfg.TASK_STORE_DIR });
  const db = createPool(cfg.DATABASE_URL);
  try {
    const summary = await new RunRepository(db).getRunSummary(runId);
    console.log(`run:       ${runId}`);
    console.log(`workflow:  ${desc.status.name}`);
    console.log(`status:    ${wf.status}`);
    console.log('stages:');
    for (const s of wf.stages) console.log(`  ${s.at}  ${s.stage}`);
    if (wf.taskId) {
      console.log(`task:      ${wf.taskId}`);
      console.log(`task file: ${tasks.locate(wf.taskId)}`);
      for (const r of await tasks.getResults(wf.taskId))
        console.log(`result:    ${r.kind} (${r.producedBy}) ${JSON.stringify(r.payload)}`);
    }
    if (wf.decision)
      console.log(
        `decision:  ${wf.decision.decision} by ${wf.decision.source}:${wf.decision.actor}`,
      );
    console.log(
      summary
        ? `postgres:  status=${summary.run.status} results=${summary.results.length} approvals=${summary.approvals.length} costUsd=${summary.totalCostUsd}`
        : 'postgres:  no run record yet',
    );
    console.log(
      `temporal UI: http://127.0.0.1:8233/namespaces/${cfg.TEMPORAL_NAMESPACE}/workflows/${runId}`,
    );
  } finally {
    await db.end();
  }
}

async function decide(
  runId: string,
  decision: 'approve' | 'reject',
  flags: Record<string, string>,
) {
  idSchema.parse(runId);
  const { client, connection } = await temporalClient();
  const handle = client.workflow.getHandle(runId);
  const actor = flags['actor'] ?? process.env['USER'] ?? 'human';
  const signal: DecisionSignal = {
    decisionId: `decision-${randomUUID().slice(0, 12)}`,
    decision,
    source: 'human',
    actor,
    ...(flags['reason'] ? { reason: flags['reason'] } : {}),
  };
  try {
    await handle.signal(DECISION_SIGNAL, signal);
  } catch (e) {
    if (!/already completed/i.test(String((e as Error).message))) throw e;
    const done = (await handle.result()) as WorkflowStatus;
    await connection.close();
    console.log(`run already decided; final status: ${done.status} (no change made)`);
    return;
  }
  console.log(`sent ${decision} (source=human, actor=${actor}); waiting for completion...`);
  const result = (await handle.result()) as WorkflowStatus;
  await connection.close();
  console.log(`final status: ${result.status}`);
}

const probe = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host, port, timeout: 2000 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.once('timeout', () => (s.destroy(), resolve(false)));
  });

async function doctor() {
  const checks: [string, boolean, string?][] = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push(['node >= 20.3', major >= 20, process.versions.node]);
  const cfg = loadBaseConfig();
  checks.push(['EXECUTION_MODE', true, cfg.EXECUTION_MODE]);
  const [h, p] = cfg.TEMPORAL_ADDRESS.split(':');
  checks.push([
    'temporal reachable',
    await probe(h ?? '127.0.0.1', Number(p ?? 7233)),
    cfg.TEMPORAL_ADDRESS,
  ]);
  const dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) checks.push(['DATABASE_URL set', false]);
  else {
    const db = createPool(dbUrl);
    try {
      await db.query('SELECT 1');
      const t = await db.query("SELECT to_regclass('public.runs') AS t");
      checks.push(['postgres reachable', true]);
      checks.push([
        'migrations applied',
        Boolean((t.rows[0] as { t: string | null }).t),
        'run `pnpm db:migrate` if failing',
      ]);
    } catch {
      checks.push(['postgres reachable', false]);
    } finally {
      await db.end();
    }
  }
  for (const [name, ok, detail] of checks)
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
}

async function migrateCmd() {
  const db = createPool(loadConfig().DATABASE_URL);
  try {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'no pending migrations');
  } finally {
    await db.end();
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'start':
      return start(flags);
    case 'status':
      return status(positional[0] ?? fail('runId required'));
    case 'approve':
    case 'reject':
      return decide(positional[0] ?? fail('runId required'), cmd, flags);
    case 'migrate':
      return migrateCmd();
    case 'doctor':
      return doctor();
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

function fail(msg: string): never {
  throw new Error(msg);
}

main().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
