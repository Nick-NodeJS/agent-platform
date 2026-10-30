# ADR 0003: Signed approval gates and explicit trust boundaries

**Status:** Accepted, implemented. Recorded retrospectively (it replaced an earlier unsigned approval signal).

## Context

Agent approval and human approval are different events. A `source: human` field or an actor name is only a claim; anything with access
to Temporal could send it. An approval must also apply to exactly the results the human reviewed.

## Decision

- The workflow opens a **review gate** only after results are stored and projected. The gate lists artifact IDs and SHA-256 digests.
- A human decision is a **signed envelope** (Ed25519) covering run, gate, artifacts, decision, decision ID, signer key ID, actor and expiry,
  submitted as a Temporal **Update** that is validated before acceptance, then verified in an Activity against a **public trusted-signers file**.
  The first valid decision wins; early, stale, expired, replayed or mismatched decisions are rejected and never buffered.
- The private key stays with the human CLI on the trusted host (outside the repository); the worker receives only public keys and refuses
  to start if the signer path is in its environment. Key generation is an explicit command.
- The mock business owner can never approve.
- One logical run ID has **one immutable human decision**: only failed, undecided runs may restart with the same ID (Temporal `ALLOW_DUPLICATE_FAILED_ONLY`); Postgres refuses to reuse a decided run ID (`RunAlreadyDecided`) and stores the decision with its gate closure in one transaction (`DecisionConflict` on any different decision). The workflow's final decision comes from the stored value.

## Consequences

- Approval proves use of a trusted key, **not** a human click; same-OS-user access defeats key isolation ([security](../architecture/security.md)).
- Container/network isolation of future agents is planned, not implemented, and must exist before real tool execution.
- Workflows started before the signed Update are not replay-compatible; new runs are required. The later canonical-decision change is guarded with `patched()`.
- A new evaluation needs a new run ID; there is no decision reversal.

## Source pointers

[`approval.ts`](../../packages/contracts/src/approval.ts), [`node.ts`](../../packages/contracts/src/node.ts),
[`workflows/index.ts`](../../apps/worker/src/workflows/index.ts), [`activities.ts`](../../apps/worker/src/activities.ts),
[`decide.ts`](../../apps/cli/src/commands/decide.ts), [`worker-env.ts`](../../apps/worker/src/worker-env.ts).
