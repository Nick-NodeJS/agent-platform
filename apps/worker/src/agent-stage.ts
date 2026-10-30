import { randomUUID } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import {
  ExecutorNotStartedError,
  type AgentExecutor,
  type AgentRole,
  type Result,
  type ResultKind,
  type TaskStore,
} from '@platform/contracts';
import { canonicalJson } from '@platform/contracts';
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

export interface AgentStageArgs<I, O> {
  runId: string;
  taskId: string;
  role: AgentRole;
  stage: string;
  kind: ResultKind;
  resultId: string;
  input: I;
  validateOutput: (output: unknown) => O;
}

export interface AgentStageResult<O> {
  resultId: string;
  output: O;
  digest: string;
  reused: boolean;
}

export const UNCERTAIN_FAILURE = 'ExecutionOutcomeUncertain';
export const BUSY_FAILURE = 'ExecutionInProgress';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const executionIdFor = (runId: string, role: string, stage: string) =>
  `${runId}:${role}:${stage}`.slice(0, 200);

/**
 * Executes one agent stage at most once per (run, role, stage, input) unless an operator reconciles it.
 *
 *  1. A succeeded execution is reused: canonical stored result is re-projected, never re-executed.
 *  2. Otherwise the attempt claims a fenced DB lease, marks `invoked_at` BEFORE the external call, then runs.
 *  3. Output + usage + canonical result are persisted in one transaction; the task projection happens afterwards.
 *  4. If the external call may have happened but nothing was persisted, the execution becomes `uncertain`
 *     and is NOT started again (non-retryable failure; operator reconciliation required).
 */
export async function runAgentStage<I, O>(
  deps: AgentStageDeps,
  args: AgentStageArgs<I, O>,
): Promise<AgentStageResult<O>> {
  const { repo, tasks, executor, leaseTtlMs } = deps;
  const now = deps.now ?? (() => new Date());
  const inputDigest = digestPayload(args.input);
  const executionId = executionIdFor(args.runId, args.role, args.stage);

  try {
    await repo.ensureExecution({
      executionId,
      runId: args.runId,
      role: args.role,
      stage: args.stage,
      inputDigest,
    });
  } catch (e) {
    if (e instanceof ExecutionInputMismatchError)
      throw ApplicationFailure.nonRetryable(e.message, 'ExecutionInputMismatch');
    throw e;
  }

  const reuse = async (rec: ExecutionRecord): Promise<AgentStageResult<O>> => {
    const result = rec.resultId ? await repo.getResult(rec.resultId) : undefined;
    if (!result || !rec.output)
      throw ApplicationFailure.nonRetryable(
        `execution ${executionId} succeeded but canonical result is missing`,
        'CanonicalResultMissing',
      );
    await project(result, rec);
    return {
      resultId: result.resultId,
      output: args.validateOutput(rec.output),
      digest: result.digest ?? digestPayload(result.payload),
      reused: true,
    };
  };

  const project = async (
    result: Result,
    rec: Pick<ExecutionRecord, 'costUsd' | 'steps' | 'attempts'>,
  ) => {
    // Repairs a missing task projection / cost entry without calling the agent.
    await tasks.attachResult(args.taskId, result);
    await repo.insertCost({
      entryId: executionId,
      runId: args.runId,
      role: args.role,
      costUsd: rec.costUsd ?? 0,
      steps: rec.steps ?? 0,
      attempts: rec.attempts,
    });
  };

  const existing = await repo.getExecution(executionId);
  if (existing?.state === 'succeeded') return reuse(existing);

  const token = randomUUID();
  const claim = await repo.claimExecution(executionId, token, leaseTtlMs);
  if (!claim) {
    const rec = (await repo.getExecution(executionId))!;
    if (rec.state === 'succeeded') return reuse(rec);
    if (rec.state === 'running' && rec.leaseExpired && rec.invokedAt) {
      await repo.markUncertainIfAbandoned(
        executionId,
        'lease expired after the executor was invoked and no result was persisted',
      );
      throw uncertain(executionId, 'attempt abandoned after invoking the executor');
    }
    if (rec.state === 'uncertain') throw uncertain(executionId, rec.uncertainReason ?? 'unknown');
    throw ApplicationFailure.retryable(
      `execution ${executionId} is in progress elsewhere`,
      BUSY_FAILURE,
    );
  }

  let leaseLost = false;
  const heartbeat = setInterval(
    () => {
      repo
        .renewLease(executionId, token, claim.fence, leaseTtlMs)
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch(() => undefined);
    },
    Math.max(Math.floor(leaseTtlMs / 3), 250),
  );

  try {
    try {
      await repo.markInvoked(executionId, token, claim.fence);
    } catch (e) {
      if (e instanceof StaleExecutionError)
        throw ApplicationFailure.retryable(e.message, BUSY_FAILURE);
      throw e;
    }

    let response;
    try {
      response = await executor.run<I, unknown>({
        role: args.role,
        runId: args.runId,
        idempotencyKey: `${executionId}:${inputDigest.slice(0, 16)}`,
        input: args.input,
      });
    } catch (e) {
      if (e instanceof ExecutorNotStartedError) {
        await repo.abortInvocation(executionId, token, claim.fence);
        throw ApplicationFailure.nonRetryable(e.message, 'ExecutorNotStarted');
      }
      await repo.markUncertainOwned(
        executionId,
        token,
        claim.fence,
        `executor error: ${(e as Error).message}`,
      );
      throw uncertain(executionId, 'executor failed after it may have started');
    }

    let output: O;
    try {
      output = args.validateOutput(response.output);
    } catch (e) {
      await repo.markUncertainOwned(
        executionId,
        token,
        claim.fence,
        `invalid executor output: ${(e as Error).message}`,
      );
      throw uncertain(executionId, 'executor returned invalid output');
    }

    const payload = JSON.parse(canonicalJson(output)) as Record<string, unknown>;
    const digest = sha256Hex(canonicalJson(payload));
    const result: Result = {
      resultId: args.resultId,
      taskId: args.taskId,
      runId: args.runId,
      kind: args.kind,
      producedBy: response.executedBy,
      payload,
      digest,
      createdAt: now().toISOString(),
    };

    const tries = deps.persistAttempts ?? 3;
    let lastError: unknown;
    for (let i = 0; i < tries; i++) {
      if (leaseLost) break;
      try {
        await repo.completeExecution({
          executionId,
          token,
          fence: claim.fence,
          output: payload,
          executedBy: response.executedBy,
          costUsd: response.usage.costUsd,
          steps: response.usage.steps,
          result,
        });
        lastError = undefined;
        break;
      } catch (e) {
        lastError = e;
        if (e instanceof StaleExecutionError) break;
        await sleep(100 * (i + 1));
      }
    }
    if (lastError || leaseLost) {
      // The executor ran but its result was not durably stored: never run it again automatically.
      await repo
        .markUncertainOwned(
          executionId,
          token,
          claim.fence,
          'executor finished but result persistence failed',
        )
        .catch(() => undefined);
      throw uncertain(executionId, 'executor finished but the result could not be persisted');
    }

    const done = (await repo.getExecution(executionId))!;
    await project(result, done);
    return { resultId: result.resultId, output, digest, reused: false };
  } finally {
    clearInterval(heartbeat);
  }
}

function uncertain(executionId: string, why: string) {
  return ApplicationFailure.nonRetryable(
    `execution ${executionId} outcome is uncertain (${why}); reconcile it with "pnpm cli reconcile" before re-running`,
    UNCERTAIN_FAILURE,
  );
}
