import type { ModelPricing } from '@platform/contracts';

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  /** Includes reasoning tokens, which are billed as output. */
  outputTokens: number;
}

const TOKENS_PER_MILLION = 1_000_000;
const COST_DECIMALS = 1_000_000;

/**
 * Cost of one call from the provider's reported usage and the hand-maintained price list. Search content tokens are
 * part of the reported input tokens, so they are priced as input; web searches add a flat fee per call.
 */
export function computeCallCostUsd(
  usage: TokenUsage,
  webSearchCalls: number,
  pricing: ModelPricing,
): number {
  const longContext = usage.inputTokens > pricing.longContextThresholdTokens;
  const inputMultiplier = longContext ? pricing.longContextInputMultiplier : 1;
  const outputMultiplier = longContext ? pricing.longContextOutputMultiplier : 1;
  const cachedTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedTokens = usage.inputTokens - cachedTokens;
  const tokenCost =
    (uncachedTokens * pricing.inputPerMTokUsd * inputMultiplier +
      cachedTokens * pricing.cachedInputPerMTokUsd * inputMultiplier +
      usage.outputTokens * pricing.outputPerMTokUsd * outputMultiplier) /
    TOKENS_PER_MILLION;
  const total = tokenCost + webSearchCalls * pricing.webSearchPerCallUsd;
  return Math.round(total * COST_DECIMALS) / COST_DECIMALS;
}
