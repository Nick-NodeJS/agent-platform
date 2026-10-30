import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
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
}

/** Atomic JSON file task store. Every mutation is idempotent on its stable id. Jira is a future implementation. */
export class LocalTaskStore implements TaskStore {
  private readonly root: string;
  private readonly markdown: boolean;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: LocalTaskStoreOptions) {
    this.root = path.resolve(options.rootDir);
    this.markdown = options.markdown ?? true;
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

  private async withLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(
      taskId,
      next.catch(() => undefined),
    );
    return next;
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
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, target);
  }

  private async write(file: TaskFile): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const safe = redactDeep(file);
    await this.atomicWrite(this.filePath(file.task.taskId), JSON.stringify(safe, null, 2));
    if (this.markdown)
      await this.atomicWrite(this.filePath(file.task.taskId, 'md'), renderMarkdown(safe));
  }

  private mutate(taskId: string, fn: (f: TaskFile) => void): Promise<Task> {
    return this.withLock(taskId, async () => {
      const file = await this.read(taskId);
      if (!file) throw new Error(`task not found: ${taskId}`);
      fn(file);
      await this.write(file);
      return file.task;
    });
  }

  async createTask(input: Task): Promise<Task> {
    const task = taskSchema.parse(input);
    return await this.withLock(task.taskId, async () => {
      const existing = await this.read(task.taskId);
      if (existing) return existing.task;
      await this.write({ task, results: [], approvals: [] });
      return task;
    });
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return (await this.read(taskId))?.task;
  }

  async changeStatus(taskId: string, status: Status): Promise<Task> {
    return await this.mutate(taskId, (f) => {
      if (f.task.status === status) return;
      f.task.status = status;
      f.task.updatedAt = new Date().toISOString();
    });
  }

  async attachResult(taskId: string, input: Result): Promise<Task> {
    const result = resultSchema.parse(input);
    return await this.mutate(taskId, (f) => {
      if (f.results.some((r) => r.resultId === result.resultId)) return;
      f.results.push(result);
      f.task.resultIds.push(result.resultId);
      f.task.updatedAt = new Date().toISOString();
    });
  }

  async recordApproval(taskId: string, input: Approval): Promise<Task> {
    const approval = approvalSchema.parse(input);
    return await this.mutate(taskId, (f) => {
      if (f.approvals.some((a) => a.approvalId === approval.approvalId)) return;
      f.approvals.push(approval);
      f.task.approvalIds.push(approval.approvalId);
      f.task.updatedAt = new Date().toISOString();
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
