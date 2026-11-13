# ADR 0006: Platform-enforced limits and two human gates

**Status:** Accepted direction (owner decision, 2026-11-13). **Partly implemented:** the constraints file, structured outputs and platform checks exist
(roadmap Step 2); automatic stop on a rejected proposal and the go-live gate are pending (Step 4 and later).

## Context

The owner wants the business-owner agent to decide whether a proposal is good, within stated technical and financial limits, and to approve only
the start of implementation and go-live. Agents must see the limits clearly, and a model must not be the only thing applying them.

## Decision

- Limits and technical rules live in one validated file (`config/platform-constraints.json`) with command-line overrides. Unset values are `unknown`, never guessed.
- Proposals and evaluations are structured and numeric; the platform recomputes the limit checks in code and overrides a model's `proceed` when a rule fails.
- The owner's two gates are **start of implementation** and **go-live**. The existing signed human gate becomes the first one; the business owner's recommendation is an
  agent decision, never a human approval.
- Hosting is production-grade and simple: AWS preferred, any provider allowed when it fits the limits, single deployable first, extra complexity needs a justification.
- The agents' own compute allowance is separate from the product budget and is configured in Step 3.
- Team size is not a limit: the team is the agent roles.

## Consequences

- Until Step 4 a "do-not-proceed" evaluation is shown but still waits for a human step.
- The architecture thresholds (more than 2 deployable units; kubernetes, microservices, multi-region) are defaults chosen by the assistant and need the owner's confirmation.
- Pre-launch revenue and margin are assumptions; post-launch tracking is future work.
- Stored results from before this change use the old proposal shape and are not readable by the new schema; they belong to decided or abandoned mock runs.

## Source pointers

[`constraints.ts`](../../packages/contracts/src/constraints.ts), [`research.ts`](../../packages/contracts/src/research.ts),
[`platform-constraints.json`](../../config/platform-constraints.json), [`activities.ts`](../../apps/worker/src/activities.ts) (`runBusinessOwner`),
[research spec](../research-spec.md).
