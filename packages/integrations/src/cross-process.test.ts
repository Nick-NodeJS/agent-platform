import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from '@platform/contracts';
import { LocalTaskStore } from './index.js';

const helper = fileURLToPath(new URL('../test-helpers/store-child.mjs', import.meta.url));
const ts = '2026-01-01T00:00:00.000Z';
const task = (id: string): Task => ({
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

const children = new Set<ChildProcess>();
const child = (...args: string[]) => {
  const p = spawn(process.execPath, [helper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(p);
  let out = '';
  let err = '';
  p.stdout!.on('data', (d) => (out += d));
  p.stderr!.on('data', (d) => (err += d));
  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
    p.on('exit', (code) => resolve({ code, out, err })),
  );
  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const t = setInterval(() => out.includes(text) && (clearInterval(t), resolve()), 20);
      p.once(
        'exit',
        () => (
          clearInterval(t),
          out.includes(text) ? resolve() : reject(new Error(`exited before ${text}: ${err}`))
        ),
      );
    });
  return { p, done, waitFor };
};

describe('LocalTaskStore across processes', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tasks-xproc-'));
  });
  afterEach(async () => {
    for (const p of children) p.kill('SIGKILL');
    children.clear();
    await rm(dir, { recursive: true, force: true });
  });

  it('concurrent creation from many processes is safe', async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => child('create', dir, 'task-1').done),
    );
    expect(runs.every((r) => r.code === 0)).toBe(true);
    const store = new LocalTaskStore({ rootDir: dir });
    expect((await store.getTask('task-1'))?.taskId).toBe('task-1');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('concurrent result, approval and status writes from separate processes preserve every update', async () => {
    await new LocalTaskStore({ rootDir: dir }).createTask(task('task-1'));
    const jobs = [
      ...Array.from({ length: 8 }, (_, i) => child('attach', dir, 'task-1', `res-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => child('approval', dir, 'task-1', `appr-${i}`)),
      child('status', dir, 'task-1', 'RESEARCHING'),
      child('status', dir, 'task-1', 'EVALUATING'),
    ];
    const results = await Promise.all(jobs.map((j) => j.done));
    expect(results.map((r) => r.code)).toEqual(results.map(() => 0));
    const store = new LocalTaskStore({ rootDir: dir });
    const t = (await store.getTask('task-1'))!;
    expect(t.resultIds.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `res-${i}`).sort());
    expect(t.approvalIds).toHaveLength(4);
    expect((await store.getResults('task-1')).length).toBe(8);
    // Defined ordering: statuses only move forward, regardless of arrival order.
    expect(t.status).toBe('EVALUATING');
    const md = await readFile(path.join(dir, 'task-1.md'), 'utf8');
    for (let i = 0; i < 8; i++) expect(md).toContain(`res-${i}`);
  });

  it('status transitions follow the defined order, not arrival order', async () => {
    const store = new LocalTaskStore({ rootDir: dir });
    await store.createTask(task('task-1'));
    await store.changeStatus('task-1', 'WAITING_FOR_HUMAN_APPROVAL');
    await store.changeStatus('task-1', 'RESEARCHING');
    expect((await store.getTask('task-1'))?.status).toBe('WAITING_FOR_HUMAN_APPROVAL');
    await store.changeStatus('task-1', 'REJECTED');
    await store.changeStatus('task-1', 'APPROVED');
    await store.changeStatus('task-1', 'EVALUATING');
    expect((await store.getTask('task-1'))?.status).toBe('REJECTED');
  });

  it('a killed lock holder does not block writers forever; Markdown is rebuilt without duplicates', async () => {
    const store = new LocalTaskStore({ rootDir: dir, lockStaleMs: 2500, lockTimeoutMs: 30000 });
    await store.createTask(task('task-1'));
    const holder = child('hold-after-json', dir, 'task-1', 'res-held');
    await holder.waitFor('JSON-WRITTEN');
    holder.p.kill('SIGKILL');
    await holder.done;

    const started = Date.now();
    await store.attachResult('task-1', {
      resultId: 'res-after',
      taskId: 'task-1',
      runId: 'run-1',
      kind: 'research-proposal',
      producedBy: 'mock',
      payload: {},
      createdAt: ts,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);

    // The killed process wrote JSON (canonical) but never the Markdown; retrying its op must not duplicate.
    const retry = await child('attach', dir, 'task-1', 'res-held').done;
    expect(retry.code).toBe(0);
    const t = (await store.getTask('task-1'))!;
    expect(t.resultIds.sort()).toEqual(['res-after', 'res-held']);
    const md = await readFile(path.join(dir, 'task-1.md'), 'utf8');
    expect(md).toContain('res-held');
    expect((md.match(/\(res-held,/g) ?? []).length).toBe(1);
    expect(
      (await store.getResults('task-1')).filter((r) => r.resultId === 'res-held'),
    ).toHaveLength(1);
  });

  it('a waiting writer times out (bounded) when the holder is alive', async () => {
    await new LocalTaskStore({ rootDir: dir }).createTask(task('task-1'));
    const holder = child('hold', dir, 'task-1');
    await holder.waitFor('LOCKED');
    const impatient = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: 600, lockStaleMs: 30000 });
    await expect(impatient.changeStatus('task-1', 'RESEARCHING')).rejects.toThrow(/timed out/);
  });

  it('exceptions inside the critical section release the lock', async () => {
    let boom = true;
    const store = new LocalTaskStore({
      rootDir: dir,
      lockTimeoutMs: 1000,
      hooks: {
        afterJsonWrite: () => {
          if (boom) throw new Error('crash between JSON and Markdown');
        },
      },
    });
    await expect(store.createTask(task('task-1'))).rejects.toThrow(/crash/);
    boom = false;
    // Lock was released: the retry does not wait for staleness, and repairs the missing Markdown projection.
    const started = Date.now();
    await store.createTask(task('task-1'));
    expect(Date.now() - started).toBeLessThan(900);
    expect(await readFile(path.join(dir, 'task-1.md'), 'utf8')).toContain('task-1');
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('interrupted Markdown projection can be rebuilt from canonical JSON', async () => {
    const store = new LocalTaskStore({ rootDir: dir });
    await store.createTask(task('task-1'));
    await rm(path.join(dir, 'task-1.md'));
    expect(await store.rebuildProjection('task-1')).toBe(true);
    expect(await readFile(path.join(dir, 'task-1.md'), 'utf8')).toContain('# t');
    expect(await store.rebuildProjection('missing-task')).toBe(false);
  });
});
