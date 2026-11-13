import { ApplicationFailure } from '@temporalio/activity';
import type { AgentSpendLimit } from '@platform/contracts';
import type { RunRepository } from '@platform/persistence';

export const BUDGET_NOT_CONFIGURED_FAILURE = 'BudgetNotConfigured';
export const BUDGET_EXCEEDED_FAILURE = 'BudgetExceeded';

export interface SpendPolicy {
  /** A call is not started with less than this left, because one call can overshoot the remainder. */
  minRemainingBudgetUsd: number;
  /** What an `uncertain` execution counts as, since its real cost is unknown. */
  assumedUncertainCostUsd: number;
}

const startOfUtcMonth = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/**
 * Platform-side spending guard, checked before every paid agent call (fail closed). It bounds what is *started*:
 * a single call can still overshoot what is left, so the provider-side project limit remains the outer boundary.
 * Throws non-retryable failures; the caller releases its claim because nothing was started.
 */
export async function assertWithinSpendLimits(
  repo: Pick<RunRepository, 'spendTotals'>,
  runId: string,
  limit: AgentSpendLimit,
  policy: SpendPolicy,
  now: Date,
): Promise<void> {
  if (limit === 'unknown') {
    throw ApplicationFailure.nonRetryable(
      'real agent execution needs limits.agentSpend (USD per run and per month); it is unknown',
      BUDGET_NOT_CONFIGURED_FAILURE,
    );
  }
  const totals = await repo.spendTotals(runId, startOfUtcMonth(now));
  const runSpent = totals.runUsd + totals.runUncertain * policy.assumedUncertainCostUsd;
  const monthSpent = totals.monthUsd + totals.monthUncertain * policy.assumedUncertainCostUsd;
  const remainingRun = limit.perRunUsd - runSpent;
  const remainingMonth = limit.perMonthUsd - monthSpent;
  const needed = Math.max(policy.minRemainingBudgetUsd, Number.EPSILON);
  if (remainingRun < needed) {
    throw ApplicationFailure.nonRetryable(
      `run budget used up: spent ${runSpent.toFixed(4)} of ${limit.perRunUsd} USD for this run`,
      BUDGET_EXCEEDED_FAILURE,
    );
  }
  if (remainingMonth < needed) {
    throw ApplicationFailure.nonRetryable(
      `monthly budget used up: spent ${monthSpent.toFixed(4)} of ${limit.perMonthUsd} USD this month (UTC)`,
      BUDGET_EXCEEDED_FAILURE,
    );
  }
}
