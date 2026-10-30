import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import {
  ExecutorNotStartedError,
  canonicalJson,
  toCanonicalObject,
  type AgentExecutor,
  type AgentRoleIO,
  type ExecutableRole,
  type Result,
  type ResultKind,
  type TaskStore,
} from '@platform/contracts';
import { digestPayload, sha256Hex } from '@platform/contracts/node';
import {
  ExecutionInputMismatchError,
  StaleExecutionError,
  type ExecutionRecord,
  type RunRepository,
} from '@platform/persistence';

export interface AgentStageDeps {
  repo: RunRepository;
  tasks: TaskStore;
  executor: AgentExecutor;
  leaseTtlMs: number;
  /** In-attempt retries of the canonical persistence step after the executor already returned. */
  persistAttempts?: number;
  now?: () => Date;
}

export interface AgentStageArgs<R extends ExecutableRole> {
  runId: string;
  taskId: string;
  role: R;
  stage: string;
  kind: ResultKind;
  resultId: string;
  input: AgentRoleIO[R]['input'];
  /** Executor output is untrusted (model/API response): it is validated before anything is persisted. */
  validateOutput: (output: unknown) => AgentRoleIO[R]['output'];
}

export interface AgentStageResult<O> {
  resultId: string;
  output: O;
  digest: string;
  reused: boolean;
}

export const UNCERTAIN_FAILURE = 'ExecutionOutcomeUncertain';
export const BUSY_FAILURE = 'ExecutionInProgress';

const DEFAULT_PERSIST_ATTEMPTS = 3;
const PERSIST_RETRY_BACKOFF_MS = 100;
const MIN_HEARTBEAT_INTERVAL_MS = 250;
const LEASE_RENEWALS_PER_TTL = 3;
const IDEMPOTENCY_DIGEST_CHARS = 16;
const MAX_EXECUTION_ID_CHARS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const executionIdFor = (runId: string, role: string, stage: string) =>
  `${runId}:${role}:${stage}`.slice(0, MAX_EXECUTION_ID_CHARS);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const uncertainFailure = (executionId: string, why: string) =>
  ApplicationFailure.nonRetryable(
    `execution ${executionId} outcome is uncertain (${why}); reconcile it with "pnpm cli reconcile" before re-running`,
    UNCERTAIN_FAILURE,
  );

/** Everything one attempt needs once it owns the execution lease. */
interface ClaimedAttempt<R extends ExecutableRole> {
  executionId: string;
  inputDigest: string;
  token: string;
  fence: number;
  args: AgentStageArgs<R>;
}

/**
 * Executes one agent stage at most once per (run, role, stage, input) unless an operator reconciles it.
 *
 *  1. A succeeded execution is reused: the canonical stored result is re-projected, never re-executed.
 *  2. Otherwise the attempt claims a fenced DB lease, marks `invoked_at` BEFORE the external call, then runs.
 *  3. Output + usage + canonical result are persisted in one transaction; the task projection happens afterwards.
 *  4. If the external call may have happened but nothing was persisted, the execution becomes `uncertain`
 *     and is NOT started again (non-retryable failure; operator reconciliation required).
 */
export async function runAgentStage<R extends ExecutableRole>(
  deps: AgentStageDeps,
  args: AgentStageArgs<R>,
): Promise<AgentStageResult<AgentRoleIO[R]['output']>> {
  const inputDigest = digestPayload(args.input);
  const executionId = executionIdFor(args.runId, args.role, args.stage);
  await ensureExecutionRecord(deps, args, executionId, inputDigest);

  const existing = await deps.repo.getExecution(executionId);
  if (existing?.state === 'succeeded') {
    return reuseStoredResult(deps, args, existing);
  }

  const token = randomUUID();
  const claim = await deps.repo.claimExecution(executionId, token, deps.leaseTtlMs);
  if (!claim) {
    return reuseOrExplainWhyNot(deps, args, executionId);
  }
  const attempt: ClaimedAttempt<R> = { executionId, inputDigest, token, fence: claim.fence, args };
  return withLeaseRenewal(deps, attempt, (isLeaseLost) =>
    invokeAndPersist(deps, attempt, isLeaseLost),
  );
}

async function ensureExecutionRecord<R extends ExecutableRole>(
  { repo }: AgentStageDeps,
  args: AgentStageArgs<R>,
  executionId: string,
  inputDigest: string,
): Promise<void> {
  try {
    await repo.ensureExecution({
      executionId,
      runId: args.runId,
      role: args.role,
      stage: args.stage,
      inputDigest,
    });
  } catch (error) {
    if (error instanceof ExecutionInputMismatchError) {
      throw ApplicationFailure.nonRetryable(error.message, 'ExecutionInputMismatch');
    }
    throw error;
  }
}

/** Re-projects the canonical result into the task store and cost ledger; repairs gaps without calling the agent. */
async function projectResult<R extends ExecutableRole>(
  { repo, tasks }: AgentStageDeps,
  args: AgentStageArgs<R>,
  result: Result,
  usage: Pick<ExecutionRecord, 'costUsd' | 'steps' | 'attempts'>,
): Promise<void> {
  await tasks.attachResult(args.taskId, result);
  await repo.insertCost({
    entryId: executionIdFor(args.runId, args.role, args.stage),
    runId: args.runId,
    role: args.role,
    costUsd: usage.costUsd ?? 0,
    steps: usage.steps ?? 0,
    attempts: usage.attempts,
  });
}

async function reuseStoredResult<R extends ExecutableRole>(
  deps: AgentStageDeps,
  args: AgentStageArgs<R>,
  execution: ExecutionRecord,
): Promise<AgentStageResult<AgentRoleIO[R]['output']>> {
  const result = execution.resultId ? await deps.repo.getResult(execution.resultId) : undefined;
  if (!result || !execution.output) {
    throw ApplicationFailure.nonRetryable(
      `execution ${execution.executionId} succeeded but canonical result is missing`,
      'CanonicalResultMissing',
    );
  }
  await projectResult(deps, args, result, execution);
  return {
    resultId: result.resultId,
    output: args.validateOutput(execution.output),
    digest: result.digest ?? digestPayload(result.payload),
    reused: true,
  };
}

/** The claim failed: another attempt owns it, it finished meanwhile, or its outcome is unknown. */
async function reuseOrExplainWhyNot<R extends ExecutableRole>(
  deps: AgentStageDeps,
  args: AgentStageArgs<R>,
  executionId: string,
): Promise<AgentStageResult<AgentRoleIO[R]['output']>> {
  const current = await deps.repo.getExecution(executionId);
  if (current?.state === 'succeeded') {
    return reuseStoredResult(deps, args, current);
  }
  if (current?.state === 'running' && current.leaseExpired && current.invokedAt) {
    await deps.repo.markUncertainIfAbandoned(
      executionId,
      'lease expired after the executor was invoked and no result was persisted',
    );
    throw uncertainFailure(executionId, 'attempt abandoned after invoking the executor');
  }
  if (current?.state === 'uncertain') {
    throw uncertainFailure(executionId, current.uncertainReason ?? 'unknown');
  }
  throw ApplicationFailure.retryable(
    `execution ${executionId} is in progress elsewhere`,
    BUSY_FAILURE,
  );
}

/** Keeps the lease alive while the attempt runs; reports (rather than hides) a lost lease. */
async function withLeaseRenewal<R extends ExecutableRole, T>(
  { repo, leaseTtlMs }: AgentStageDeps,
  { executionId, token, fence }: ClaimedAttempt<R>,
  action: (isLeaseLost: () => boolean) => Promise<T>,
): Promise<T> {
  let leaseLost = false;
  const intervalMs = Math.max(
    Math.floor(leaseTtlMs / LEASE_RENEWALS_PER_TTL),
    MIN_HEARTBEAT_INTERVAL_MS,
  );
  const timer = setInterval(() => {
    repo
      .renewLease(executionId, token, fence, leaseTtlMs)
      .then((renewed) => {
        leaseLost ||= !renewed;
      })
      .catch(() => {
        // A transient renewal failure is not proof the lease is lost; expiry is decided by the database.
      });
  }, intervalMs);
  try {
    return await action(() => leaseLost);
  } finally {
    clearInterval(timer);
  }
}

async function invokeAndPersist<R extends ExecutableRole>(
  deps: AgentStageDeps,
  attempt: ClaimedAttempt<R>,
  isLeaseLost: () => boolean,
): Promise<AgentStageResult<AgentRoleIO[R]['output']>> {
  const { repo, executor } = deps;
  const { executionId, inputDigest, token, fence, args } = attempt;

  try {
    await repo.markInvoked(executionId, token, fence);
  } catch (error) {
    if (error instanceof StaleExecutionError) {
      throw ApplicationFailure.retryable(error.message, BUSY_FAILURE);
    }
    throw error;
  }

  let response;
  try {
    response = await executor.run({
      role: args.role,
      runId: args.runId,
      idempotencyKey: `${executionId}:${inputDigest.slice(0, IDEMPOTENCY_DIGEST_CHARS)}`,
      input: args.input,
    });
  } catch (error) {
    if (error instanceof ExecutorNotStartedError) {
      await repo.abortInvocation(executionId, token, fence);
      throw ApplicationFailure.nonRetryable(error.message, 'ExecutorNotStarted');
    }
    await repo.markUncertainOwned(
      executionId,
      token,
      fence,
      `executor error: ${errorMessage(error)}`,
    );
    throw uncertainFailure(executionId, 'executor failed after it may have started');
  }

  let output;
  try {
    output = args.validateOutput(response.output);
  } catch (error) {
    await repo.markUncertainOwned(
      executionId,
      token,
      fence,
      `invalid executor output: ${errorMessage(error)}`,
    );
    throw uncertainFailure(executionId, 'executor returned invalid output');
  }

  const payload = toCanonicalObject(output);
  const digest = sha256Hex(canonicalJson(payload));
  const result: Result = {
    resultId: args.resultId,
    taskId: args.taskId,
    runId: args.runId,
    kind: args.kind,
    producedBy: response.executedBy,
    payload,
    digest,
    createdAt: (deps.now ?? (() => new Date()))().toISOString(),
  };

  const persistFailure = await persistWithRetries(deps, attempt, isLeaseLost, {
    output: payload,
    executedBy: response.executedBy,
    costUsd: response.usage.costUsd,
    steps: response.usage.steps,
    result,
  });
  if (persistFailure) {
    // The executor ran but its result was not durably stored: never run it again automatically.
    // If even this write fails, the lease expires and the abandoned-attempt path marks it uncertain.
    await repo
      .markUncertainOwned(executionId, token, fence, `result persistence failed: ${persistFailure}`)
      .catch(() => undefined);
    throw uncertainFailure(executionId, 'executor finished but the result could not be persisted');
  }

  const completed = await repo.getExecution(executionId);
  if (!completed) {
    throw new Error(`execution ${executionId} disappeared after completion`);
  }
  await projectResult(deps, args, result, completed);
  return { resultId: result.resultId, output, digest, reused: false };
}

/** Returns undefined once persisted, otherwise a short reason why the result could not be stored. */
async function persistWithRetries<R extends ExecutableRole>(
  deps: AgentStageDeps,
  { executionId, token, fence }: ClaimedAttempt<R>,
  isLeaseLost: () => boolean,
  completion: {
    output: Record<string, unknown>;
    executedBy: 'mock' | 'agent';
    costUsd: number;
    steps: number;
    result: Result;
  },
): Promise<string | undefined> {
  const maxAttempts = deps.persistAttempts ?? DEFAULT_PERSIST_ATTEMPTS;
  let lastReason = 'no attempts made';
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    if (isLeaseLost()) {
      return 'lease lost';
    }
    try {
      await deps.repo.completeExecution({ executionId, token, fence, ...completion });
      return undefined;
    } catch (error) {
      if (error instanceof StaleExecutionError) {
        return 'attempt no longer owns the execution';
      }
      lastReason = errorMessage(error);
      await sleep(PERSIST_RETRY_BACKOFF_MS * attemptNumber);
    }
  }
  return lastReason;
}
