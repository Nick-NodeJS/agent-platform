import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, Connection, WorkflowUpdateFailedError } from '@temporalio/client';
import {
  DECISION_UPDATE,
  MAX_APPROVAL_VALIDITY_MS,
  APPROVAL_VERSION,
  STATUS_QUERY,
  WORKFLOW_NAME,
  idSchema,
  loadBaseConfig,
  loadConfig,
  resourceConstraintsSchema,
  type ApprovalPayload,
  type DecisionAck,
  type ResearchProposalInput,
  type WorkflowStatus,
} from '@platform/contracts';
import {
  generateSigner,
  loadSignerFile,
  loadTrustedSigners,
  signApproval,
} from '@platform/contracts/node';
import { LocalTaskStore } from '@platform/integrations';
import { createPool, migrate, RunRepository } from '@platform/persistence';

if (existsSync('.env')) process.loadEnvFile('.env');

const USAGE = `Usage: agent-platform <command>

  start --goal <text> [--run-id <id>] [--budget-usd <n>] [--team-size <n>] [--timeline-weeks <n>] [--notes <text>]
  status <runId>
  approve <runId> [--reason <text>] [--ttl-minutes <n>]     (signed with your approval signer key)
  reject <runId> [--reason <text>] [--ttl-minutes <n>]
  approval-keygen --actor <name> [--key-id <id>] [--dir <dir outside the repo>]
  executions <runId>
  reconcile <runId> <researcher|business-owner> --confirm-no-external-run
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
      if (a === '--confirm-no-external-run') flags[a.slice(2)] = '';
      else {
        if (value === undefined || value.startsWith('--'))
          throw new Error(`missing value for ${a}`);
        flags[a.slice(2)] = value;
        i++;
      }
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

const DEFAULT_APPROVAL_DIR = path.join(os.homedir(), '.config', 'agent-platform', 'approval');

function signerPath() {
  return process.env['APPROVAL_SIGNER_FILE'] || path.join(DEFAULT_APPROVAL_DIR, 'signer.json');
}

async function decide(
  runId: string,
  decision: 'approve' | 'reject',
  flags: Record<string, string>,
) {
  idSchema.parse(runId);
  const signer = loadSignerFile(signerPath());
  const { client, connection } = await temporalClient();
  try {
    const handle = client.workflow.getHandle(runId);
    const wf = await handle.query<WorkflowStatus>(STATUS_QUERY);
    if (wf.decision) {
      console.log(
        `run already decided: ${wf.decision.decision}; final status ${wf.status} (no change made)`,
      );
      return;
    }
    if (!wf.gate) {
      process.exitCode = 1;
      console.error(
        `not ready: run ${runId} is ${wf.status}; the review gate is not open yet. Nothing was submitted; retry once it is WAITING_FOR_HUMAN_APPROVAL.`,
      );
      return;
    }
    const ttlMs = Math.min(Number(flags['ttl-minutes'] ?? 10) * 60_000, MAX_APPROVAL_VALIDITY_MS);
    const issued = new Date();
    const payload: ApprovalPayload = {
      version: APPROVAL_VERSION,
      decisionId: `dec-${randomUUID().slice(0, 16)}`,
      runId,
      gateId: wf.gate.gateId,
      artifacts: wf.gate.artifacts,
      decision,
      keyId: signer.keyId,
      actor: signer.actor,
      ...(flags['reason'] ? { reason: flags['reason'] } : {}),
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + ttlMs).toISOString(),
    };
    const envelope = signApproval(payload, signer);
    let ack: DecisionAck;
    try {
      ack = await handle.executeUpdate<DecisionAck, [unknown]>(DECISION_UPDATE, {
        args: [envelope],
      });
    } catch (e) {
      process.exitCode = 1;
      const msg =
        e instanceof WorkflowUpdateFailedError
          ? ((e.cause as { message?: string } | undefined)?.message ?? e.message)
          : e instanceof Error
            ? e.message
            : String(e);
      console.error(`decision NOT accepted: ${msg}`);
      return;
    }
    console.log(
      `accepted ${ack.decision} (human-controlled signer ${signer.keyId}, actor ${signer.actor}) for gate ${ack.gateId}; waiting for completion...`,
    );
    const result = (await handle.result()) as WorkflowStatus;
    console.log(`final status: ${result.status}`);
  } finally {
    await connection.close();
  }
}

function approvalKeygen(flags: Record<string, string>) {
  const actor = flags['actor'];
  if (!actor) throw new Error('--actor is required');
  const keyId = idSchema.parse(flags['key-id'] ?? `key-${randomUUID().slice(0, 8)}`);
  const dir = path.resolve(flags['dir'] ?? DEFAULT_APPROVAL_DIR);
  const repoRoot = path.resolve(process.cwd());
  if (dir === repoRoot || dir.startsWith(repoRoot + path.sep))
    throw new Error(
      `refusing to write keys inside the repository (${repoRoot}); choose --dir outside it`,
    );
  const signerFile = path.join(dir, 'signer.json');
  const trustedFile = path.join(dir, 'trusted-signers.json');
  if (existsSync(signerFile) || existsSync(trustedFile))
    throw new Error(`keys already exist in ${dir}; refusing to overwrite (choose another --dir)`);
  const { signer, trusted } = generateSigner(keyId, actor);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(signerFile, JSON.stringify(signer, null, 2), { mode: 0o600, flag: 'wx' });
  writeFileSync(trustedFile, JSON.stringify([trusted], null, 2), { mode: 0o644, flag: 'wx' });
  console.log(`private signer (keep secret; human CLI only): ${signerFile}`);
  console.log(`public trusted-signers file (for the worker):  ${trustedFile}`);
  console.log(`Set in .env (worker):  APPROVAL_TRUSTED_SIGNERS_FILE=${trustedFile}`);
  console.log(
    'Do NOT put the private signer path in the shared .env or any agent/worker environment.',
  );
  console.log(
    `The CLI finds the signer at ${DEFAULT_APPROVAL_DIR}/signer.json by default, or via APPROVAL_SIGNER_FILE in your own shell.`,
  );
}

async function executions(runId: string) {
  const db = createPool(loadConfig().DATABASE_URL);
  try {
    for (const e of await new RunRepository(db).listExecutions(idSchema.parse(runId)))
      console.log(
        `${e.executionId}  state=${e.state} attempts=${e.attempts} cost=${e.costUsd ?? 'n/a'} ${e.uncertainReason ? `reason="${e.uncertainReason}"` : ''}`,
      );
  } finally {
    await db.end();
  }
}

async function reconcile(runId: string, role: string, flags: Record<string, string>) {
  if (flags['confirm-no-external-run'] === undefined)
    throw new Error(
      'pass --confirm-no-external-run only after verifying out-of-band that no paid run happened (or accepting a re-run)',
    );
  const stage =
    role === 'researcher' ? 'research' : role === 'business-owner' ? 'evaluation' : undefined;
  if (!stage) throw new Error('role must be researcher or business-owner');
  const db = createPool(loadConfig().DATABASE_URL);
  try {
    const id = `${idSchema.parse(runId)}:${role}:${stage}`;
    console.log(
      (await new RunRepository(db).resetUncertain(id))
        ? `reset ${id}; start the run again with the same --run-id`
        : `${id} is not uncertain`,
    );
  } finally {
    await db.end();
  }
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
  const signersFile = cfg.APPROVAL_TRUSTED_SIGNERS_FILE;
  if (!signersFile)
    checks.push([
      'approval trusted signers configured',
      false,
      'set APPROVAL_TRUSTED_SIGNERS_FILE',
    ]);
  else {
    try {
      checks.push([
        'approval trusted signers readable',
        loadTrustedSigners(signersFile).length > 0,
      ]);
    } catch {
      checks.push(['approval trusted signers readable', false]);
    }
  }
  checks.push([
    'approval signer private key available to CLI',
    true,
    existsSync(signerPath())
      ? 'present (human CLI only)'
      : 'not found; only needed on the machine where a human approves',
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
    case 'approval-keygen':
      return approvalKeygen(flags);
    case 'executions':
      return executions(positional[0] ?? fail('runId required'));
    case 'reconcile':
      return reconcile(
        positional[0] ?? fail('runId required'),
        positional[1] ?? fail('role required'),
        flags,
      );
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
