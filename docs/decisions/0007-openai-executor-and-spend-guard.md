# ADR 0007: Direct OpenAI executor with a platform-side spending guard

**Status:** Accepted (owner decision, 2026-11-13). **Implemented and tested against a fake provider only;** it has not yet been
run against the live API (see the validation report). Builds on [ADR 5](0005-direct-api-research-first.md) and [ADR 6](0006-limits-and-two-human-gates.md).

## Context

The first real researcher and business-owner need a model with web search, an enforced USD allowance, restricted tools and execution logging.
The owner chose OpenAI (`gpt-6.1-sol`, built-in web search) with 3 USD per run and 20 USD per month. A Devin subscription has no
per-run cost reporting we can read, so it cannot enforce a USD cap; it stays a candidate for later coding steps.

## Decision

- `OpenAiAgentExecutor` calls the Responses API directly (no agent framework). Settings live in `config/model-profiles.json`: model, reasoning effort,
  output-token and tool-call ceilings, search context size, allowed tools, call time limit, prices, and the guard's reserve. The API key is read from the worker's environment
  (`OPENAI_API_KEY`); the file holds only the variable name.
- The researcher gets the `web_search` tool only; the business owner gets no tools. Output is a strict JSON schema, parsed and validated again by Zod. Citations come from the
  search tool's own annotations and are appended to the demand evidence. `store: false`.
- **Cost** is computed from the usage the provider reports and the hand-maintained price list (cached input, long-context multipliers, per-search fee). A model without a price is refused.
- **Spending guard** (platform, before every paid call, fail closed): `limits.agentSpend` must be set, and the run's and the month's (UTC) spent amount plus an assumed cost per `uncertain`
  execution must leave at least `minRemainingBudgetUsd`. Otherwise the stage fails non-retryably with `BudgetNotConfigured` or `BudgetExceeded`, and its claim is released.
- Failure classification follows the executor contract: HTTP 400/401/403/404/422/429 and "could not connect" mean not started; anything else (5xx, timeout, abort, invalid or incomplete
  response) means "may have run" and leaves the execution `uncertain`.
- Each completed call stores an `agent.call.completed` event (model, tokens, searches, duration, response id) in the same transaction as the result and cost.

## Consequences

- The guard bounds what is **started**. One call can overshoot what is left (search content tokens are billed as input and are not capped by us), so the owner should also set a project spend limit
  in the OpenAI dashboard as the outer boundary.
- A paid call whose output fails validation is `uncertain` and its cost is not recorded (it counts at the assumed amount until reconciled).
- Rate-limit (429) responses are not retried automatically; the failed, undecided run can be restarted with the same run ID.
- Prices and model names are configuration that can go stale; the `asOf` date is recorded next to them.
- Real runs go through the owner's single gate that exists today; automatic stop on a business-owner rejection is still pending (ADR 6).

## Source pointers

[`executor.ts`](../../packages/integrations/src/openai/executor.ts), [`cost.ts`](../../packages/integrations/src/openai/cost.ts),
[`model-output.ts`](../../packages/integrations/src/openai/model-output.ts), [`prompts.ts`](../../packages/integrations/src/openai/prompts.ts),
[`spend-guard.ts`](../../apps/worker/src/spend-guard.ts), [`model-profiles.json`](../../config/model-profiles.json),
[`model-profiles.ts`](../../packages/contracts/src/model-profiles.ts), [`openai-live-check.ts`](../../scripts/openai-live-check.ts).
