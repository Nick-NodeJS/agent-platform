# AGENTS.md

## Scope

Platform repository: reusable orchestration engine and shared packages (pnpm monorepo, TypeScript only).
Product repositories are created later, only after research, business-owner evaluation, and explicit human approval.
Milestone 1 = infrastructure, contracts, and an executable **mock** workflow. No paid model calls, cloud resources, or product repos.

## Architecture rules

- Temporal owns durable execution, retries, approval waits, recovery. PostgreSQL owns business records and cost accounting.
- Workflows (`apps/worker/src/workflows`) must be deterministic: no filesystem, DB, network, random IDs, or agent calls. Those belong in Activities.
- Activities must be idempotent (stable IDs, `ON CONFLICT`), with bounded retries/timeouts. Pass artifact references, not full transcripts/secrets, through Temporal payloads.
- Agent approval and human approval are different events. A `source` or `actor` string is a caller claim, never proof. A human decision is accepted only as an Ed25519-signed envelope (run, gate, artifact digests, decision ID, signer key ID, actor, issued/expiry) verified in an Activity against the public trusted-signers file. The workflow accepts it only through a validated Temporal Update while the review gate is open; early/stale/mismatched decisions are rejected, never buffered.
- Private approval keys exist only on the trusted human host (outside the repo). The worker and agents must never receive them (`APPROVAL_SIGNER_FILE` in the worker env makes the worker refuse to start). Mock/real agent code must never have access to the signer or the Temporal/DB control plane.
- Agent executions go through `runAgentStage`: durable `agent_executions` record, fenced DB lease, `invoked_at` recorded before the external call, canonical result persisted transactionally, task projection afterwards. If an invoked execution has no stored result it becomes `uncertain` and is never re-run automatically.
- LocalTaskStore writes must hold the per-task cross-process file lock; JSON is canonical, Markdown is a rebuildable projection; statuses only move forward.
- Real execution must never silently fall back to mock; unconfigured profiles are rejected at the executor boundary (`assertProfileConfigured`).
- Task storage goes through the `TaskStore` interface (local files now, Jira later). Execution goes through `AgentExecutor` (mock now, OpenHands later).
- Do not add packages/services without a real responsibility; mark deferred integrations clearly.

## Verification commands

```sh
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm infra:up && pnpm db:migrate
pnpm test:integration   # live Temporal + Postgres (temporary database), needs Docker
pnpm smoke              # end-to-end CLI flow with a temporary signing key
```

## Security expectations

- **Prompt instructions are not security boundaries.** Access restrictions (filesystem, network, credentials, budgets) must be enforced outside the model.
- Never commit `.env`, credentials, private signing keys, runtime task outputs, logs, or artifacts. Profiles reference env var NAMES only.
- Never log secrets; redact before persisting. No Docker socket mounted into ordinary agent containers; document any privileged sandbox manager explicitly.
- Pin container image versions (no `latest`) and GitHub Actions to commit SHAs.
