import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Result, Task } from '@platform/contracts';
import { LocalTaskStore, LockTimeoutError } from './index.js';

// The fixture is compiled with the package (src/fixtures/store-child.ts); `pnpm test` builds first.
const fixture = fileURLToPath(new URL('../dist/fixtures/store-child.js', import.meta.url));
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

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

const result = (taskId: string, resultId: string): Result => ({
  resultId,
  taskId,
  runId: 'run-1',
  kind: 'research-proposal',
  producedBy: 'mock',
  payload: { id: resultId },
  createdAt: TIMESTAMP,
});

const READY_POLL_MS = 20;
const CHILD_WAIT_MS = 15_000;
/** Longer than the 2.5 s "stale" window the previous mtime-based lock used; proves there is no expiry any more. */
const PAUSED_OWNER_OBSERVATION_MS = 3000;
const NO_STALE_WAIT_BOUND_MS = 1500;
const CONTENDED_ATTEMPT_TIMEOUT_MS = 30;
const CONTENDED_ATTEMPTS = 40;
const LOCK_MODE_MASK = 0o777;
const LOCK_FILE_MODE = 0o600;

const children = new Set<ChildProcess>();

/** Spawns one fixture operation. `waitFor` is a readiness barrier on the child's stdout, bounded by a timeout. */
const child = (...args: string[]) => {
  const proc = spawn(process.execPath, [fixture, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(proc);
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    proc.on('exit', (code) => resolve({ code, out: stdout, err: stderr }));
  });

  const waitFor = (text: string) =>
    new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + CHILD_WAIT_MS;
      const timer = setInterval(() => {
        if (stdout.includes(text)) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline || proc.exitCode !== null) {
          clearInterval(timer);
          reject(new Error(`child never printed "${text}": ${stderr}`));
        }
      }, READY_POLL_MS);
    });

  return {
    process: proc,
    done,
    waitFor,
    send: (line: string) => proc.stdin.write(line),
  };
};

const requireTask = async (store: LocalTaskStore, taskId: string): Promise<Task> => {
  const found = await store.getTask(taskId);
  if (!found) {
    throw new Error(`task ${taskId} should exist`);
  }
  return found;
};

const openFileDescriptors = () => readdirSync('/proc/self/fd').length;

describe('LocalTaskStore across processes (Linux flock)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tasks-xproc-'));
  });
  afterEach(async () => {
    // A stopped process ignores SIGKILL delivery until continued on some kernels; always continue first.
    for (const proc of children) {
      proc.kill('SIGCONT');
      proc.kill('SIGKILL');
    }
    children.clear();
    await rm(dir, { recursive: true, force: true });
  });

  it('concurrent creation of the same task from many processes is safe', async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => child('create', dir, 'task-1').done),
    );
    expect(runs.map((run) => run.code)).toEqual(runs.map(() => 0));
    const store = new LocalTaskStore({ rootDir: dir });
    expect((await requireTask(store, 'task-1')).taskId).toBe('task-1');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('concurrent result, approval and status writes from separate processes preserve every update', async () => {
    await new LocalTaskStore({ rootDir: dir }).createTask(task('task-1'));
    const jobs = [
      ...Array.from({ length: 8 }, (_, i) => child('attach', dir, 'task-1', `res-${i}`)),
      ...Array.from({ length: 4 }, (_, i) => child('approval', dir, 'task-1', `appr-${i}`)),
      child('status', dir, 'task-1', 'RESEARCHING'),
      child('status', dir, 'task-1', 'EVALUATING'),
    ];
    const outcomes = await Promise.all(jobs.map((job) => job.done));
    expect(outcomes.map((outcome) => outcome.code)).toEqual(outcomes.map(() => 0));

    const store = new LocalTaskStore({ rootDir: dir });
    const stored = await requireTask(store, 'task-1');
    expect([...stored.resultIds].sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `res-${i}`).sort(),
    );
    expect(stored.approvalIds).toHaveLength(4);
    expect(await store.getResults('task-1')).toHaveLength(8);
    // Defined ordering: statuses only move forward, regardless of arrival order.
    expect(stored.status).toBe('EVALUATING');
    const markdown = await readFile(path.join(dir, 'task-1.md'), 'utf8');
    for (let i = 0; i < 8; i++) {
      expect(markdown).toContain(`res-${i}`);
    }
  });

  it('status transitions follow the defined order, not arrival order', async () => {
    const store = new LocalTaskStore({ rootDir: dir });
    await store.createTask(task('task-1'));
    await store.changeStatus('task-1', 'WAITING_FOR_HUMAN_APPROVAL');
    await store.changeStatus('task-1', 'RESEARCHING');
    expect((await requireTask(store, 'task-1')).status).toBe('WAITING_FOR_HUMAN_APPROVAL');
    await store.changeStatus('task-1', 'REJECTED');
    await store.changeStatus('task-1', 'APPROVED');
    await store.changeStatus('task-1', 'EVALUATING');
    expect((await requireTask(store, 'task-1')).status).toBe('REJECTED');
  });

  it('a paused (SIGSTOP) owner keeps the lock: contenders time out instead of stealing it, and no update is lost', async () => {
    const store = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: PAUSED_OWNER_OBSERVATION_MS });
    await store.createTask(task('task-1'));

    const owner = child('pause-before-publish', dir, 'task-1', 'res-owner');
    await owner.waitFor('PAUSED-BEFORE-PUBLISH'); // lock held, temporary file written, rename not yet done
    owner.process.kill('SIGSTOP');

    const started = Date.now();
    await expect(
      store.attachResult('task-1', result('task-1', 'res-waiter')),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(PAUSED_OWNER_OBSERVATION_MS - 200);
    // The owner has published nothing yet; lock-free readers still see a valid old snapshot.
    expect(await store.getResults('task-1')).toEqual([]);

    owner.process.kill('SIGCONT');
    owner.send('go\n');
    expect((await owner.done).code).toBe(0);

    await store.attachResult('task-1', result('task-1', 'res-waiter'));
    const stored = await requireTask(store, 'task-1');
    expect([...stored.resultIds].sort()).toEqual(['res-owner', 'res-waiter']);
    expect(await store.getResults('task-1')).toHaveLength(2);
  });

  it('a killed owner releases the lock immediately (no stale wait); a kill between publications is repaired', async () => {
    const store = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: CHILD_WAIT_MS });
    await store.createTask(task('task-1'));

    const holder = child('hold', dir, 'task-1');
    await holder.waitFor('LOCKED');
    holder.process.kill('SIGKILL');
    await holder.done;
    const started = Date.now();
    await store.changeStatus('task-1', 'RESEARCHING');
    expect(Date.now() - started).toBeLessThan(NO_STALE_WAIT_BOUND_MS);

    const writer = child('hold-after-json', dir, 'task-1', 'res-killed');
    await writer.waitFor('JSON-WRITTEN');
    writer.process.kill('SIGKILL');
    await writer.done;

    // JSON (canonical) was published and is valid; the Markdown projection missed that update.
    expect((await store.getResults('task-1')).map((r) => r.resultId)).toEqual(['res-killed']);
    expect(await readFile(path.join(dir, 'task-1.md'), 'utf8')).not.toContain('res-killed');

    expect(await store.rebuildProjection('task-1')).toBe(true);
    expect(await readFile(path.join(dir, 'task-1.md'), 'utf8')).toContain('res-killed');
    // Retrying the interrupted operation is idempotent: no duplicate result.
    expect((await child('attach', dir, 'task-1', 'res-killed').done).code).toBe(0);
    expect(await store.getResults('task-1')).toHaveLength(1);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('a waiting writer times out (bounded) while the holder is alive', async () => {
    await new LocalTaskStore({ rootDir: dir }).createTask(task('task-1'));
    const holder = child('hold', dir, 'task-1');
    await holder.waitFor('LOCKED');
    const impatient = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: 600 });
    await expect(impatient.changeStatus('task-1', 'RESEARCHING')).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
  });
});

describe('LocalTaskStore inside one process', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'tasks-inproc-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('an exception inside the protected operation releases the lock for the next writer', async () => {
    let failNextPublish = true;
    const store = new LocalTaskStore({
      rootDir: dir,
      lockTimeoutMs: 1000,
      hooks: {
        afterJsonWrite: () => {
          if (failNextPublish) {
            throw new Error('crash between JSON and Markdown');
          }
        },
      },
    });
    await expect(store.createTask(task('task-1'))).rejects.toThrow(/crash/);
    failNextPublish = false;

    await store.createTask(task('task-1')); // acquires at once and repairs the missing Markdown
    expect(await readFile(path.join(dir, 'task-1.md'), 'utf8')).toContain('task-1');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('separate instances contend on the same task, while unrelated tasks do not block each other', async () => {
    let releaseHolder = () => {};
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderHasLock = () => {};
    const holderLocked = new Promise<void>((resolve) => {
      holderHasLock = resolve;
    });
    const holder = new LocalTaskStore({
      rootDir: dir,
      hooks: {
        afterLock: async () => {
          holderHasLock();
          await holderGate;
        },
      },
    });
    const other = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: 300 });
    await other.createTask(task('task-b'));

    const holding = holder.createTask(task('task-a'));
    await holderLocked;

    await expect(other.createTask(task('task-a'))).rejects.toBeInstanceOf(LockTimeoutError);
    await other.changeStatus('task-b', 'RESEARCHING'); // different task: not blocked
    expect((await requireTask(other, 'task-b')).status).toBe('RESEARCHING');

    releaseHolder();
    await holding;
    await other.createTask(task('task-a'));
    expect((await requireTask(other, 'task-a')).taskId).toBe('task-a');
  });

  it('never deletes or replaces the lock file, and repeated contention does not leak descriptors', async () => {
    const store = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: CONTENDED_ATTEMPT_TIMEOUT_MS });
    await store.createTask(task('task-1'));
    const lockFile = path.join(await realpath(dir), '.locks', 'task-1.lock');
    const before = await stat(lockFile);
    expect(before.mode & LOCK_MODE_MASK).toBe(LOCK_FILE_MODE);

    let releaseHolder = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let locked = () => {};
    const holderLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = new LocalTaskStore({
      rootDir: dir,
      hooks: {
        afterLock: async () => {
          locked();
          await gate;
        },
      },
    });
    const descriptorsBefore = openFileDescriptors();
    const holding = holder.changeStatus('task-1', 'RESEARCHING');
    await holderLocked;
    for (let attempt = 0; attempt < CONTENDED_ATTEMPTS; attempt++) {
      await expect(store.changeStatus('task-1', 'EVALUATING')).rejects.toBeInstanceOf(
        LockTimeoutError,
      );
    }
    releaseHolder();
    await holding;
    for (let i = 0; i < CONTENDED_ATTEMPTS; i++) {
      await store.attachResult('task-1', result('task-1', `res-${i}`));
    }

    const after = await stat(lockFile);
    expect({ ino: after.ino, dev: after.dev }).toEqual({ ino: before.ino, dev: before.dev });
    expect(openFileDescriptors()).toBe(descriptorsBefore);
  });

  it('lock-free readers only ever see complete, valid snapshots while writers publish', async () => {
    const store = new LocalTaskStore({ rootDir: dir, lockTimeoutMs: CHILD_WAIT_MS });
    await store.createTask(task('task-1'));
    const WRITES = 30;
    let writing = true;
    const writers = (async () => {
      for (let i = 0; i < WRITES; i++) {
        await store.attachResult('task-1', result('task-1', `res-${i}`));
      }
      writing = false;
    })();

    let previousCount = 0;
    let reads = 0;
    while (writing) {
      const results = await store.getResults('task-1'); // throws on malformed JSON
      const ids = results.map((entry) => entry.resultId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(previousCount);
      previousCount = ids.length;
      reads++;
    }
    await writers;
    expect(reads).toBeGreaterThan(0);
    expect(await store.getResults('task-1')).toHaveLength(WRITES);
  });
});
