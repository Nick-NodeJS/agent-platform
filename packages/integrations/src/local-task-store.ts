import { mkdir, readFile, rename, writeFile, readdir, unlink } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  approvalSchema,
  idSchema,
  resultSchema,
  taskSchema,
  type Approval,
  type Result,
  type Status,
  type Task,
  type TaskStore,
} from '@platform/contracts';
import { redactDeep } from './redact.js';

interface TaskFile {
  task: Task;
  results: Result[];
  approvals: Approval[];
}

export interface LocalTaskStoreOptions {
  rootDir: string;
  markdown?: boolean;
  /** Max time to wait for a task lock before failing (default 15s). */
  lockTimeoutMs?: number;
  /** A lock whose mtime is older than this is considered abandoned (default 30s, min 2s). Holders refresh every stale/2. */
  lockStaleMs?: number;
  /** Test-only fault injection points. */
  hooks?: { afterLock?: () => Promise<void> | void; afterJsonWrite?: () => Promise<void> | void };
}

export class LockTimeoutError extends Error {}
export class LockCompromisedError extends Error {}

/**
 * Status ordering. Concurrent/retried status writes are resolved by this order, not by arrival time:
 * a status may only move forward; APPROVED/REJECTED are terminal (first terminal status wins).
 */
const STATUS_RANK: Record<Status, number> = {
  CREATED: 0,
  RESEARCHING: 1,
  EVALUATING: 2,
  WAITING_FOR_HUMAN_APPROVAL: 3,
  APPROVED: 4,
  REJECTED: 4,
};
const isTerminal = (s: Status) => STATUS_RANK[s] === 4;

/**
 * JSON-file task store with Markdown projection.
 *
 * Cross-process safety: every operation (including createTask and the JSON+Markdown writes) is a
 * read-modify-write under one lock per task at `<root>/.locks/<taskId>.lock`, implemented with
 * `proper-lockfile` (atomic mkdir; holder refreshes the lock mtime; locks not refreshed for `lockStaleMs`
 * are taken over). Guarantees hold on local POSIX filesystems with sane clocks; NOT on NFS/SMB or
 * network-synced folders. A live holder that stalls longer than `lockStaleMs` (e.g. event loop blocked)
 * may lose the lock; it detects this (`onCompromised`) and aborts before renaming over the JSON.
 * JSON is canonical; Markdown is a rebuildable projection.
 */
export class LocalTaskStore implements TaskStore {
  private readonly root: string;
  private readonly markdown: boolean;
  private readonly lockTimeoutMs: number;
  private readonly lockStaleMs: number;
  private readonly hooks: NonNullable<LocalTaskStoreOptions['hooks']>;

  constructor(options: LocalTaskStoreOptions) {
    this.root = path.resolve(options.rootDir);
    this.markdown = options.markdown ?? true;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
    this.lockStaleMs = Math.max(options.lockStaleMs ?? 30_000, 2000);
    this.hooks = options.hooks ?? {};
  }

  private filePath(taskId: string, ext = 'json'): string {
    const safe = idSchema.parse(taskId);
    const full = path.resolve(this.root, `${safe}.${ext}`);
    if (path.dirname(full) !== this.root) throw new Error('task path escapes store root');
    return full;
  }

  locate(taskId: string): string {
    return this.filePath(taskId);
  }

  private lockPath(taskId: string): string {
    const safe = idSchema.parse(taskId);
    return path.join(this.root, '.locks', `${safe}.lock`);
  }

  private async withLock<T>(
    taskId: string,
    fn: (assertHeld: () => void) => Promise<T>,
  ): Promise<T> {
    const lockPath = this.lockPath(taskId);
    await mkdir(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    for (let delay = 10; !release; delay = Math.min(delay * 2, 200)) {
      try {
        // `file` must be unique per task: proper-lockfile keys its in-process lock registry by it.
        release = await lockfile.lock(lockPath, {
          lockfilePath: lockPath,
          realpath: false,
          stale: this.lockStaleMs,
          update: Math.floor(this.lockStaleMs / 2),
          retries: 0,
          onCompromised: (err) => {
            compromised = new LockCompromisedError(err.message);
          },
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ELOCKED') throw e;
        if (Date.now() + delay > deadline)
          throw new LockTimeoutError(`timed out locking task ${taskId}`);
        await new Promise((r) => setTimeout(r, delay + Math.random() * delay));
      }
    }
    try {
      await this.hooks.afterLock?.();
      return await fn(() => {
        if (compromised) throw compromised;
      });
    } finally {
      await release().catch(() => undefined);
    }
  }

  private async read(taskId: string): Promise<TaskFile | undefined> {
    try {
      const raw = JSON.parse(await readFile(this.filePath(taskId), 'utf8')) as TaskFile;
      return {
        task: taskSchema.parse(raw.task),
        results: raw.results.map((r) => resultSchema.parse(r)),
        approvals: raw.approvals.map((a) => approvalSchema.parse(a)),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, 'utf8');
      await rename(tmp, target);
    } catch (e) {
      await unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /** Must be called with the task lock held. JSON first (canonical), then Markdown. */
  private async writeLocked(
    file: TaskFile,
    assertHeld: () => void,
    jsonChanged: boolean,
  ): Promise<void> {
    await mkdir(this.root, { recursive: true });
    if (jsonChanged) {
      assertHeld();
      await this.atomicWrite(
        this.filePath(file.task.taskId),
        JSON.stringify(redactDeep(file), null, 2),
      );
      await this.hooks.afterJsonWrite?.();
    }
    if (this.markdown) {
      assertHeld();
      await this.atomicWrite(
        this.filePath(file.task.taskId, 'md'),
        renderMarkdown(redactDeep(file)),
      );
    }
  }

  private mutate(taskId: string, fn: (f: TaskFile) => boolean): Promise<Task> {
    return this.withLock(taskId, async (assertHeld) => {
      const file = await this.read(taskId);
      if (!file) throw new Error(`task not found: ${taskId}`);
      const changed = fn(file);
      // Always re-project: a retry after a crash between the JSON and Markdown writes repairs the Markdown.
      await this.writeLocked(file, assertHeld, changed);
      return file.task;
    });
  }

  async createTask(input: Task): Promise<Task> {
    const task = taskSchema.parse(input);
    return await this.withLock(task.taskId, async (assertHeld) => {
      const existing = await this.read(task.taskId);
      if (existing) {
        await this.writeLocked(existing, assertHeld, false);
        return existing.task;
      }
      await this.writeLocked({ task, results: [], approvals: [] }, assertHeld, true);
      return task;
    });
  }

  /** Rebuild the Markdown projection from canonical JSON (e.g. after a crash). False for unknown tasks. */
  async rebuildProjection(taskId: string): Promise<boolean> {
    return this.withLock(taskId, async (assertHeld) => {
      const file = await this.read(taskId);
      if (!file) return false;
      await this.writeLocked(file, assertHeld, false);
      return true;
    });
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return (await this.read(taskId))?.task;
  }

  async changeStatus(taskId: string, status: Status): Promise<Task> {
    return await this.mutate(taskId, (f) => {
      const current = f.task.status;
      if (current === status || isTerminal(current)) return false;
      if (STATUS_RANK[status] <= STATUS_RANK[current]) return false;
      f.task.status = status;
      f.task.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async attachResult(taskId: string, input: Result): Promise<Task> {
    const result = resultSchema.parse(input);
    return await this.mutate(taskId, (f) => {
      if (f.results.some((r) => r.resultId === result.resultId)) return false;
      f.results.push(result);
      f.task.resultIds.push(result.resultId);
      f.task.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async recordApproval(taskId: string, input: Approval): Promise<Task> {
    const approval = approvalSchema.parse(input);
    return await this.mutate(taskId, (f) => {
      if (f.approvals.some((a) => a.approvalId === approval.approvalId)) return false;
      f.approvals.push(approval);
      f.task.approvalIds.push(approval.approvalId);
      f.task.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async getResults(taskId: string): Promise<Result[]> {
    return (await this.read(taskId))?.results ?? [];
  }

  async getApprovals(taskId: string): Promise<Approval[]> {
    return (await this.read(taskId))?.approvals ?? [];
  }

  async listTaskIds(): Promise<string[]> {
    try {
      return (await readdir(this.root))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5));
    } catch {
      return [];
    }
  }
}

function renderMarkdown({ task, results, approvals }: TaskFile): string {
  const lines = [
    `# ${task.title}`,
    '',
    `- Task: ${task.taskId}`,
    `- Run: ${task.runId}`,
    `- Status: **${task.status}**`,
    `- Updated: ${task.updatedAt}`,
    '',
    task.description,
    '',
    '## Results',
    ...results.flatMap((r) => [
      '',
      `### ${r.kind} (${r.resultId}, produced by ${r.producedBy})`,
      '```json',
      JSON.stringify(r.payload, null, 2),
      '```',
    ]),
    '',
    '## Approvals',
    ...(approvals.length
      ? approvals.map(
          (a) =>
            `- ${a.decision} by ${a.source}:${a.actor} at ${a.createdAt}${a.reason ? ` (${a.reason})` : ''}`,
        )
      : ['- none']),
    '',
  ];
  return lines.join('\n');
}
