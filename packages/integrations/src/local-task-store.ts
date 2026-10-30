import { mkdir, readFile, realpath, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
import { withExclusiveLock } from './file-lock.js';
import { redactDeep } from './redact.js';

const taskFileSchema = z.object({
  task: taskSchema,
  results: z.array(resultSchema),
  approvals: z.array(approvalSchema),
});
type TaskFile = z.infer<typeof taskFileSchema>;

const hasErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;

type Hook = () => Promise<void> | void;

export interface LocalTaskStoreOptions {
  rootDir: string;
  markdown?: boolean;
  /** Max time to wait for a contended task lock before failing with LockTimeoutError (default 15 s). */
  lockTimeoutMs?: number;
  /** Test-only fault injection points; they run while the task lock is held. */
  hooks?: {
    afterLock?: Hook;
    /** After the temporary JSON file is written, before it is renamed over the canonical file. */
    beforeJsonPublish?: Hook;
    afterJsonWrite?: Hook;
  };
}

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
const TERMINAL_RANK = 4;
const isTerminal = (status: Status) => STATUS_RANK[status] === TERMINAL_RANK;

/**
 * JSON-file task store with a Markdown projection.
 *
 * Writers: every mutation (createTask, attachResult, recordApproval, changeStatus, rebuildProjection) is one
 * read-modify-write under an exclusive Linux `flock` on `<root>/.locks/<taskId>.lock` (see file-lock.ts). The lock is
 * held until both files are published; it has no expiry, so a paused writer keeps it and contenders time out. The
 * kernel drops it when a writer dies. Supported: Linux, local filesystems. Not supported: NFS/SMB, network-synced
 * folders, multi-host coordination. The lock is advisory: every legitimate writer must go through this class.
 *
 * Publication: each file is written to a temporary name and renamed into place, so readers (which take no lock) always
 * see a complete old or new file. JSON is canonical; Markdown is published second and can be rebuilt from the JSON.
 * The two renames are NOT one atomic transaction, and nothing is fsynced, so power-loss durability is not promised.
 */
export class LocalTaskStore implements TaskStore {
  private readonly root: string;
  private readonly markdown: boolean;
  private readonly lockTimeoutMs: number;
  private readonly hooks: NonNullable<LocalTaskStoreOptions['hooks']>;

  constructor(options: LocalTaskStoreOptions) {
    this.root = path.resolve(options.rootDir);
    this.markdown = options.markdown ?? true;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.hooks = options.hooks ?? {};
  }

  private filePath(taskId: string, ext = 'json'): string {
    const safe = idSchema.parse(taskId);
    const full = path.resolve(this.root, `${safe}.${ext}`);
    if (path.dirname(full) !== this.root) {
      throw new Error('task path escapes store root');
    }
    return full;
  }

  locate(taskId: string): string {
    return this.filePath(taskId);
  }

  /** One stable lock file per validated task id, derived from the real root so every instance/process agrees. */
  private async lockPath(taskId: string): Promise<string> {
    const safe = idSchema.parse(taskId);
    await mkdir(this.root, { recursive: true });
    return path.join(await realpath(this.root), '.locks', `${safe}.lock`);
  }

  private async withLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const lockPath = await this.lockPath(taskId);
    return withExclusiveLock(lockPath, { timeoutMs: this.lockTimeoutMs }, async () => {
      await this.hooks.afterLock?.();
      return action();
    });
  }

  private async read(taskId: string): Promise<TaskFile | undefined> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath(taskId), 'utf8'));
      return taskFileSchema.parse(raw);
    } catch (e) {
      if (hasErrorCode(e, 'ENOENT')) {
        return undefined;
      }
      throw e;
    }
  }

  private async atomicWrite(target: string, content: string, beforePublish?: Hook): Promise<void> {
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, content, 'utf8');
      await beforePublish?.();
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {
        // The temporary file may never have been created; the original failure is what matters.
      });
      throw error;
    }
  }

  /** Must run with the task lock held. JSON first (canonical), then Markdown. */
  private async publish(file: TaskFile, jsonChanged: boolean): Promise<void> {
    const safeFile = redactTaskFile(file);
    if (jsonChanged) {
      await this.atomicWrite(
        this.filePath(file.task.taskId),
        JSON.stringify(safeFile, null, 2),
        this.hooks.beforeJsonPublish,
      );
      await this.hooks.afterJsonWrite?.();
    }
    if (this.markdown) {
      await this.atomicWrite(this.filePath(file.task.taskId, 'md'), renderMarkdown(safeFile));
    }
  }

  private mutate(taskId: string, apply: (file: TaskFile) => boolean): Promise<Task> {
    return this.withLock(taskId, async () => {
      const file = await this.read(taskId);
      if (!file) {
        throw new Error(`task not found: ${taskId}`);
      }
      const changed = apply(file);
      // Always re-project: a retry after a crash between the JSON and Markdown writes repairs the Markdown.
      await this.publish(file, changed);
      return file.task;
    });
  }

  async createTask(input: Task): Promise<Task> {
    const task = taskSchema.parse(input);
    return await this.withLock(task.taskId, async () => {
      const existing = await this.read(task.taskId);
      if (existing) {
        await this.publish(existing, false);
        return existing.task;
      }
      await this.publish({ task, results: [], approvals: [] }, true);
      return task;
    });
  }

  /** Rebuild the Markdown projection from canonical JSON (e.g. after a crash). False for unknown tasks. */
  async rebuildProjection(taskId: string): Promise<boolean> {
    return this.withLock(taskId, async () => {
      const file = await this.read(taskId);
      if (!file) {
        return false;
      }
      await this.publish(file, false);
      return true;
    });
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return (await this.read(taskId))?.task;
  }

  async changeStatus(taskId: string, status: Status): Promise<Task> {
    return await this.mutate(taskId, (f) => {
      const current = f.task.status;
      if (current === status || isTerminal(current)) {
        return false;
      }
      if (STATUS_RANK[status] <= STATUS_RANK[current]) {
        return false;
      }
      f.task.status = status;
      f.task.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async attachResult(taskId: string, input: Result): Promise<Task> {
    const result = resultSchema.parse(input);
    return await this.mutate(taskId, (f) => {
      if (f.results.some((r) => r.resultId === result.resultId)) {
        return false;
      }
      f.results.push(result);
      f.task.resultIds.push(result.resultId);
      f.task.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async recordApproval(taskId: string, input: Approval): Promise<Task> {
    const approval = approvalSchema.parse(input);
    return await this.mutate(taskId, (f) => {
      if (f.approvals.some((a) => a.approvalId === approval.approvalId)) {
        return false;
      }
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
}

const redactTaskFile = (file: TaskFile): TaskFile => taskFileSchema.parse(redactDeep(file));

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
