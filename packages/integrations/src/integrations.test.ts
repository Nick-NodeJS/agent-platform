import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExecutorNotStartedError,
  type Approval,
  type Result,
  type Task,
} from '@platform/contracts';
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
    const files = (await readdir(dir)).filter((f) => !f.startsWith('.')).sort();
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

  it('cleans up its temporary file when a write fails and surfaces the error', async () => {
    // A directory squatting on the JSON path makes the final rename fail after the temp file was written.
    await mkdir(path.join(dir, 'task-1.json', 'occupied'), { recursive: true });
    await expect(store.createTask(task())).rejects.toThrow();
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
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
  const researcherRequest = {
    role: 'researcher',
    runId: 'run-1',
    idempotencyKey: 'key-1',
    input: { goal: 'g', constraints },
  } as const;

  it('mock researcher is deterministic, fictional, and records unknown constraints', async () => {
    const executor = new MockAgentExecutor();
    const first = await executor.run(researcherRequest);
    const second = await executor.run(researcherRequest);
    expect(first.output).toEqual(second.output);
    expect(first.output.fictionalExample).toBe(true);
    expect(first.output.unknowns).toEqual([
      'budgetUsd was not provided by the human owner',
      'timelineWeeks was not provided by the human owner',
      'notes was not provided by the human owner',
    ]);
    expect(first.usage.costUsd).toBe(0);
    expect(first.executedBy).toBe('mock');
  });

  it('mock business owner never claims to be a human approval', async () => {
    const proposal = (await new MockAgentExecutor().run(researcherRequest)).output;
    const evaluation = await new MockAgentExecutor().run({
      role: 'business-owner',
      runId: 'run-1',
      idempotencyKey: 'key-2',
      input: { proposal, constraints },
    });
    expect(evaluation.output.isHumanApproval).toBe(false);
    expect(evaluation.output.rationale).toContain(proposal.title);
  });

  it('real execution is rejected as "not started", never silently mocked', async () => {
    const attempt = createExecutor('openhands').run(researcherRequest);
    await expect(attempt).rejects.toBeInstanceOf(RealExecutionNotImplementedError);
    await expect(attempt).rejects.toBeInstanceOf(ExecutorNotStartedError);
  });

  it('createExecutor selects the mock only for mock mode', () => {
    expect(createExecutor('mock')).toBeInstanceOf(MockAgentExecutor);
    expect(createExecutor('openhands')).not.toBeInstanceOf(MockAgentExecutor);
  });
});

describe('LocalTaskStore locks are per task', () => {
  it('interleaved operations on different tasks in one process do not interfere', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tasks-multi-'));
    try {
      const store = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: 5000 });
      const ids = ['task-a', 'task-b', 'task-c'];
      await Promise.all(ids.map((id) => store.createTask(task(id))));
      await Promise.all(
        ids.flatMap((id) =>
          Array.from({ length: 10 }, (_, i) =>
            store.attachResult(id, { ...result, taskId: id, resultId: `${id}-r${i}` }),
          ),
        ),
      );
      for (const id of ids) {
        expect(await store.getResults(id)).toHaveLength(10);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
