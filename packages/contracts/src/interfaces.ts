import type { PlatformConstraints } from './constraints.js';
import type { Approval, Result, Status, Task } from './records.js';
import type { BusinessEvaluation, ResearchProposal } from './research.js';

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

/** Thrown by an executor to signal that NO external work was started (safe to retry without risk of double billing). */
export class ExecutorNotStartedError extends Error {}

export interface ResearcherInput {
  goal: string;
  constraints: PlatformConstraints;
}

export interface BusinessOwnerInput {
  proposal: ResearchProposal;
  constraints: PlatformConstraints;
}

/** Input and output types of every role an executor can run. Add a role here when it gets a real stage. */
export interface AgentRoleIO {
  researcher: { input: ResearcherInput; output: ResearchProposal };
  'business-owner': { input: BusinessOwnerInput; output: BusinessEvaluation };
}

export type ExecutableRole = keyof AgentRoleIO;

export interface AgentRunRequest<R extends ExecutableRole = ExecutableRole> {
  role: R;
  runId: string;
  /**
   * Stable across retries of the same stage and input. Passed to the runtime so it CAN deduplicate; this only
   * helps if the provider/runtime actually implements idempotency. No exactly-once guarantee for external systems.
   */
  idempotencyKey: string;
  input: AgentRoleIO[R]['input'];
}

export interface AgentRunResponse<O> {
  output: O;
  /** `details` (model, tokens, durations, ids) is logged with the execution; it never contains secrets. */
  usage: { costUsd: number; steps: number; details?: Record<string, string | number> };
  executedBy: 'mock' | 'agent';
}

export interface AgentRunOptions {
  /**
   * Aborted when the surrounding Activity is cancelled, times out or the worker shuts down. Implementations must stop
   * the external call promptly and reject; the caller then treats the run as "may have started".
   */
  signal?: AbortSignal;
}

/**
 * Narrow execution boundary. Implementations must honor the same contract: report definitively-not-started
 * failures with ExecutorNotStartedError, treat any other failure as "may have run", honor `options.signal`, and keep
 * each external call below `EXECUTOR_CALL_LIMIT_MS`.
 * Real runtimes return untrusted data: callers validate outputs before persisting them.
 */
export interface AgentExecutor {
  run<R extends ExecutableRole>(
    request: AgentRunRequest<R>,
    options?: AgentRunOptions,
  ): Promise<AgentRunResponse<AgentRoleIO[R]['output']>>;
}
