import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { loadBaseConfig } from '@platform/contracts';
import { loadTrustedSigners } from '@platform/contracts/node';
import { resolveTaskStoreDir } from '@platform/integrations';
import { createPool } from '@platform/persistence';
import { signerFilePath, type CliContext } from '../context.js';

const MIN_NODE_MAJOR = 20;
const PROBE_TIMEOUT_MS = 2000;
const DEFAULT_TEMPORAL_PORT = 7233;

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const canConnect = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    const finish = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });

/** The task store directory is created on first use, so it must be creatable: its nearest existing parent must be writable. */
function checkTaskStoreDirectory(configured: string): Check {
  const directory = resolveTaskStoreDir(configured);
  let existing = directory;
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  try {
    accessSync(existing, constants.W_OK);
    return { name: 'task store directory writable', ok: true, detail: directory };
  } catch {
    return {
      name: 'task store directory writable',
      ok: false,
      detail: `${directory}: ${existing} is not writable`,
    };
  }
}

function checkTrustedSigners(file: string | undefined): Check {
  if (!file) {
    return {
      name: 'approval trusted signers configured',
      ok: false,
      detail: 'set APPROVAL_TRUSTED_SIGNERS_FILE',
    };
  }
  try {
    return { name: 'approval trusted signers readable', ok: loadTrustedSigners(file).length > 0 };
  } catch {
    return { name: 'approval trusted signers readable', ok: false };
  }
}

async function checkDatabase(databaseUrl: string | undefined): Promise<Check[]> {
  if (!databaseUrl) {
    return [{ name: 'DATABASE_URL set', ok: false }];
  }
  const db = createPool(databaseUrl);
  try {
    await db.query('SELECT 1');
    const migrated = await db.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.agent_executions') AS table_name",
    );
    return [
      { name: 'postgres reachable', ok: true },
      {
        name: 'migrations applied',
        ok: Boolean(migrated.rows[0]?.table_name),
        detail: 'run `pnpm db:migrate` if failing',
      },
    ];
  } catch {
    return [{ name: 'postgres reachable', ok: false }];
  } finally {
    await db.end();
  }
}

/** Returns the exit code: non-zero when any check failed. Never prints secrets. */
export async function doctorCommand(ctx: CliContext): Promise<number> {
  const config = loadBaseConfig(ctx.env);
  const [host, port] = config.TEMPORAL_ADDRESS.split(':');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const signerPresent = existsSync(signerFilePath(ctx));
  const checks: Check[] = [
    {
      name: `node >= ${MIN_NODE_MAJOR}`,
      ok: nodeMajor >= MIN_NODE_MAJOR,
      detail: process.versions.node,
    },
    {
      name: 'EXECUTION_MODE',
      ok: config.EXECUTION_MODE === 'mock',
      detail:
        config.EXECUTION_MODE === 'mock'
          ? 'mock'
          : `${config.EXECUTION_MODE}: real execution is not implemented, the worker will refuse to start`,
    },
    checkTaskStoreDirectory(config.TASK_STORE_DIR),
    {
      name: 'temporal reachable',
      ok: await canConnect(host ?? '127.0.0.1', Number(port ?? DEFAULT_TEMPORAL_PORT)),
      detail: config.TEMPORAL_ADDRESS,
    },
    checkTrustedSigners(config.APPROVAL_TRUSTED_SIGNERS_FILE),
    {
      name: 'approval signer private key available to CLI',
      ok: true,
      detail: signerPresent
        ? 'present (human CLI only)'
        : 'not found; only needed on the machine where a human approves',
    },
    ...(await checkDatabase(ctx.env['DATABASE_URL'])),
  ];
  for (const { name, ok, detail } of checks) {
    ctx.out(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  }
  return checks.every((check) => check.ok) ? 0 : 1;
}
