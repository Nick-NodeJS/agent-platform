import type { AgentRole } from './agent.js';
import type { Approval, Result, Status, Task } from './records.js';

export interface TaskStore {
  createTask(task: Task): Promise<Task>;
  getTask(taskId: string): Promise<Task | undefined>;
  changeStatus(taskId: string, status: Status): Promise<Task>;
  attachResult(taskId: string, result: Result): Promise<Task>;
  recordApproval(taskId: string, approval: Approval): Promise<Task>;
  getResults(taskId: string): Promise<Result[]>;
  getApprovals(taskId: string): Promise<Approval[]>;
  /** Human-readable location (path or URL) of the task. */
  locate(taskId: string): string;
}

export interface AgentRunRequest<I> {
  role: AgentRole;
  runId: string;
  /** Stable across retries; executors must tolerate repeats. No exactly-once guarantee for external systems. */
  idempotencyKey: string;
  input: I;
}

export interface AgentRunResponse<O> {
  output: O;
  usage: { costUsd: number; steps: number };
  executedBy: 'mock' | 'agent';
}

export interface AgentExecutor {
  run<I, O>(request: AgentRunRequest<I>): Promise<AgentRunResponse<O>>;
}
