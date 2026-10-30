import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval, Result, Task } from '@platform/contracts';
import {
  createExecutor,
  LocalTaskStore,
  MockAgentExecutor,
  RealExecutionNotImplementedError,
  redactString,
} from './index.js';

const ts = '2026-01-01T00:00:00.000Z';
const task = (id = 'task-1'): Task => ({
  taskId: id,
  runId: 'run-1',
  title: 't',
  description: 'd',
  status: 'CREATED',
  resultIds: [],
  approvalIds: [],
  createdAt: ts,
  updatedAt: ts,
});
const result: Result = {
  resultId: 'res-1',
  taskId: 'task-1',
  runId: 'run-1',
  kind: 'research-proposal',
  producedBy: 'mock',
  payload: { a: 1 },
  createdAt: ts,
};
const approval: Approval = {
  approvalId: 'appr-1',
  taskId: 'task-1',
  runId: 'run-1',
  decision: 'approve',
  source: 'human',
  actor: 'me',
  createdAt: ts,
};

describe('LocalTaskStore', () => {
  let dir: string;
  let store: LocalTaskStore;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tasks-'));
    store = new LocalTaskStore({ rootDir: dir });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('create is idempotent', async () => {
    await store.createTask(task());
    await store.changeStatus('task-1', 'RESEARCHING');
    const again = await store.createTask(task());
    expect(again.status).toBe('RESEARCHING');
    expect((await readdir(dir)).filter((f) => f.endsWith('.json'))).toEqual(['task-1.json']);
  });

  it('retried attachResult / recordApproval do not duplicate', async () => {
    await store.createTask(task());
    await store.attachResult('task-1', result);
    await store.attachResult('task-1', result);
    await store.recordApproval('task-1', approval);
    await store.recordApproval('task-1', approval);
    expect(await store.getResults('task-1')).toHaveLength(1);
    expect(await store.getApprovals('task-1')).toHaveLength(1);
    expect((await store.getTask('task-1'))?.resultIds).toEqual(['res-1']);
  });

  it('survives concurrent mutations', async () => {
    await store.createTask(task());
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.attachResult('task-1', { ...result, resultId: `r-${i}` }),
      ),
    );
    expect(await store.getResults('task-1')).toHaveLength(10);
  });

  it.each(['../evil', 'a/b', '..', '', '/etc/passwd'])('rejects unsafe id %j', async (id) => {
    await expect(store.createTask(task(id))).rejects.toThrow();
    expect(() => store.locate(id)).toThrow();
  });

  it('leaves no temp files and writes markdown', async () => {
    await store.createTask(task());
    await store.attachResult('task-1', result);
    const files = (await readdir(dir)).sort();
    expect(files).toEqual(['task-1.json', 'task-1.md']);
    expect(await readFile(path.join(dir, 'task-1.md'), 'utf8')).toContain('research-proposal');
  });

  it('redacts secrets before writing', async () => {
    await store.createTask(task());
    await store.attachResult('task-1', {
      ...result,
      payload: { note: 'key sk-abcdefghijklmnopqrstuvwxyz123456 here' },
    });
    const raw = await readFile(path.join(dir, 'task-1.json'), 'utf8');
    expect(raw).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(raw).toContain('[REDACTED]');
  });

  it('errors for unknown tasks', async () => {
    await expect(store.changeStatus('nope', 'APPROVED')).rejects.toThrow(/not found/);
  });
});

describe('redactString', () => {
  it('redacts assignments and bearer tokens', () => {
    expect(redactString('api_key=abcdef123456')).toBe('api_key=[REDACTED]');
    expect(redactString('Authorization: Bearer abcdefghijklmnopqrstuv')).toContain('[REDACTED]');
  });
});

describe('executors', () => {
  const constraints = {
    budgetUsd: 'unknown',
    teamSize: 3,
    timelineWeeks: 'unknown',
    notes: 'unknown',
  } as const;
  it('mock researcher is deterministic, fictional, and records unknowns', async () => {
    const ex = new MockAgentExecutor();
    const req = {
      role: 'researcher',
      runId: 'r',
      idempotencyKey: 'k',
      input: { goal: 'g', constraints },
    } as const;
    const a = await ex.run<unknown, { fictionalExample: boolean; unknowns: string[] }>(req);
    const b = await ex.run<unknown, unknown>(req);
    expect(a.output).toEqual(b.output);
    expect(a.output.fictionalExample).toBe(true);
    expect(a.output.unknowns.join()).toContain('budgetUsd');
    expect(a.usage.costUsd).toBe(0);
  });

  it('mock business owner never claims to be a human approval', async () => {
    const ex = new MockAgentExecutor();
    const r = await ex.run<unknown, { isHumanApproval: boolean }>({
      role: 'business-owner',
      runId: 'r',
      idempotencyKey: 'k',
      input: { proposal: { title: 'x' }, constraints },
    });
    expect(r.output.isHumanApproval).toBe(false);
  });

  it('real execution is rejected, never silently mocked', async () => {
    await expect(
      createExecutor('openhands').run({
        role: 'researcher',
        runId: 'r',
        idempotencyKey: 'k',
        input: {},
      }),
    ).rejects.toBeInstanceOf(RealExecutionNotImplementedError);
  });
});
