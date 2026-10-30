// Child-process fixture for cross-process LocalTaskStore tests (see cross-process.test.ts).
// Compiled with the package and spawned by the tests; it is not part of the public API.
//
// Protocol: one operation per process, result on stdout ("OK") or stderr ("ERR ...") with a matching exit code.
// The "hold" operations deliberately never finish: the parent test kills them with SIGKILL to model a writer
// that dies while holding a task lock or between the JSON and Markdown writes. The keepalive timer exists only
// so the process stays alive (proper-lockfile releases locks on normal exit); the parent always has a timeout.
import type { Approval, Result, Status, Task } from '@platform/contracts';
import { statusSchema } from '@platform/contracts';
import { LocalTaskStore } from '../local-task-store.js';

const TIMESTAMP = '2026-01-01T00:00:00.000Z';
const KEEPALIVE_INTERVAL_MS = 1000;
const FIXTURE_LOCK_STALE_MS = 2500;
const FIXTURE_LOCK_TIMEOUT_MS = 30_000;

const [operation, rootDir, taskId, argument = ''] = process.argv.slice(2);

function holdForever(): Promise<never> {
  setInterval(() => undefined, KEEPALIVE_INTERVAL_MS);
  return new Promise<never>(() => undefined);
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`missing argument: ${name}`);
  }
  return value;
}

const task = (id: string): Task => ({
  taskId: id,
  runId: 'run-1',
  title: 't',
  description: 'd',
  status: 'CREATED',
  resultIds: [],
  approvalIds: [],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const result = (id: string, resultId: string): Result => ({
  resultId,
  taskId: id,
  runId: 'run-1',
  kind: 'research-proposal',
  producedBy: 'mock',
  payload: { id: resultId },
  createdAt: TIMESTAMP,
});

const approval = (id: string, approvalId: string): Approval => ({
  approvalId,
  taskId: id,
  runId: 'run-1',
  decision: 'approve',
  source: 'human',
  actor: 'a',
  createdAt: TIMESTAMP,
});

async function run(): Promise<void> {
  const id = requireArg(taskId, 'taskId');
  const store = new LocalTaskStore({
    rootDir: requireArg(rootDir, 'rootDir'),
    lockStaleMs: FIXTURE_LOCK_STALE_MS,
    lockTimeoutMs: FIXTURE_LOCK_TIMEOUT_MS,
    hooks: {
      afterLock: async () => {
        if (operation === 'hold') {
          process.stdout.write('LOCKED\n');
          await holdForever();
        }
      },
      afterJsonWrite: async () => {
        if (operation === 'hold-after-json') {
          process.stdout.write('JSON-WRITTEN\n');
          await holdForever();
        }
      },
    },
  });

  switch (operation) {
    case 'create':
    case 'hold':
      await store.createTask(task(id));
      break;
    case 'attach':
    case 'hold-after-json':
      await store.attachResult(id, result(id, requireArg(argument, 'resultId')));
      break;
    case 'approval':
      await store.recordApproval(id, approval(id, requireArg(argument, 'approvalId')));
      break;
    case 'status': {
      const status: Status = statusSchema.parse(argument);
      await store.changeStatus(id, status);
      break;
    }
    default:
      throw new Error(`unknown operation: ${operation}`);
  }
  process.stdout.write('OK\n');
}

run().catch((error: unknown) => {
  process.stderr.write(`ERR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
