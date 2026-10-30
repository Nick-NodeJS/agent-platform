// Child-process helper for cross-process LocalTaskStore tests. Imports the BUILT package.
import { LocalTaskStore } from '../dist/index.js';

const [, , op, rootDir, taskId, arg] = process.argv;
const ts = '2026-01-01T00:00:00.000Z';
const hooks = {};
if (op === 'hold')
  hooks.afterLock = async () => {
    console.log('LOCKED');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
if (op === 'hold-after-json')
  hooks.afterJsonWrite = async () => {
    console.log('JSON-WRITTEN');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
const store = new LocalTaskStore({ rootDir, lockStaleMs: 2500, lockTimeoutMs: 30000, hooks });
const task = {
  taskId,
  runId: 'run-1',
  title: 't',
  description: 'd',
  status: 'CREATED',
  resultIds: [],
  approvalIds: [],
  createdAt: ts,
  updatedAt: ts,
};
const result = (id) => ({
  resultId: id,
  taskId,
  runId: 'run-1',
  kind: 'research-proposal',
  producedBy: 'mock',
  payload: { id },
  createdAt: ts,
});
const approval = (id) => ({
  approvalId: id,
  taskId,
  runId: 'run-1',
  decision: 'approve',
  source: 'human',
  actor: 'a',
  createdAt: ts,
});
try {
  if (op === 'create') await store.createTask(task);
  else if (op === 'attach') await store.attachResult(taskId, result(arg));
  else if (op === 'approval') await store.recordApproval(taskId, approval(arg));
  else if (op === 'status') await store.changeStatus(taskId, arg);
  else if (op === 'hold') await store.createTask(task);
  else if (op === 'hold-after-json') await store.attachResult(taskId, result(arg));
  else throw new Error(`unknown op ${op}`);
  console.log('OK');
} catch (e) {
  console.error(`ERR ${e?.message}`);
  process.exit(1);
}
