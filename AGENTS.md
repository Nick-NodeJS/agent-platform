# AGENTS.md

## Scope

Platform repository: reusable orchestration engine and shared packages (pnpm monorepo, TypeScript only).
Product repositories are created later, only after research, business-owner evaluation, and explicit human approval.
Milestone 1 = infrastructure, contracts, and an executable **mock** workflow. No paid model calls, cloud resources, or product repos.

## Code quality policy (mandatory)

Read [docs/code-quality.md](docs/code-quality.md) before changing code, and report which checks applied (and their
results) when you finish. Summary of the rules:

- Strict TypeScript; no `any`, non-null assertions, unsafe casts or lint/compiler suppression comments. Parse unknown
  external data (JSON, env, CLI, Temporal messages, DB rows, model output) instead of asserting types.
- Readable code: descriptive names, braces and one statement per line, small cohesive functions, named constants with units,
  comments that explain decisions only. Tests, scripts and child-process fixtures are maintained code (typechecked, linted).
- SOLID, KISS and YAGNI as judgment: narrow real boundaries (`TaskStore`, `AgentExecutor`), no speculative layers or patterns.
- Tests assert behavior (results, state transitions, persisted effects, rejected actions, retries, cleanup), not internals;
  repository-wide 80% line and 80% branch coverage floor (`pnpm test:coverage`), never met by hiding files or lowering thresholds.
- Tooling enforces the mechanical rules (Prettier, ESLint, `tsc`, Vitest, CI); the policy text is not a security boundary.
  Agents spawned by the platform get this policy through `loadPolicyContext` (`@platform/agents`), see the policy doc.

## Architecture rules

- Temporal owns durable execution, retries, approval waits, recovery. PostgreSQL owns business records and cost accounting.
- Workflows (`apps/worker/src/workflows`) must be deterministic: no filesystem, DB, network, random IDs, or agent calls. Those belong in Activities.
- Activities must be idempotent (stable IDs, `ON CONFLICT`), with bounded retries/timeouts. Pass artifact references, not full transcripts/secrets, through Temporal payloads.
- Agent approval and human approval are different events. A `source` or `actor` string is a caller claim, never proof. A human decision is accepted only as an Ed25519-signed envelope (run, gate, artifact digests, decision ID, signer key ID, actor, issued/expiry) verified in an Activity against the public trusted-signers file. The workflow accepts it only through a validated Temporal Update while the review gate is open; early/stale/mismatched decisions are rejected, never buffered.
- Private approval keys exist only on the trusted human host (outside the repo). The worker and agents must never receive them (`APPROVAL_SIGNER_FILE` in the worker env makes the worker refuse to start). Mock/real agent code must never have access to the signer or the Temporal/DB control plane.
- Agent executions go through `runAgentStage`: durable `agent_executions` record, fenced DB lease, `invoked_at` recorded before the external call, canonical result persisted transactionally, task projection afterwards. If an invoked execution has no stored result it becomes `uncertain` and is never re-run automatically.
- LocalTaskStore writes must hold the per-task Linux `flock` (via `file-lock.ts`) for the whole read-modify-write; never unlink/replace the lock file, never add stale-time takeover. The backend is Linux/local-filesystem only and advisory (all writers use the store). JSON is canonical, Markdown is a rebuildable projection; statuses only move forward.
- Real execution must never silently fall back to mock; unconfigured profiles are rejected at the executor boundary (`assertProfileConfigured`).
- Task storage goes through the `TaskStore` interface (local files now, Jira later). Execution goes through `AgentExecutor` (mock now, OpenHands later).
- Do not add packages/services without a real responsibility; mark deferred integrations clearly.
- Keep the architecture documents true: a change to behavior, contracts, persistence, permissions or deployment must update the relevant page in `docs/architecture/` and, when it changes a decision, add or supersede an ADR in `docs/decisions/`. Purely cosmetic edits need no ADR.

## Verification commands

```sh
sudo apt-get install -y build-essential python3   # once: native build tools for fs-ext (flock binding)
pnpm install --frozen-lockfile
pnpm verify              # format check, build, lint, typecheck (this order; no Docker, no tests)
pnpm test                # unit tests only (builds first, no infra needed)
pnpm infra:up && pnpm db:migrate
pnpm test:coverage      # unit + live integration tests with the 80%/80% coverage floor (needs infra above)
pnpm test:integration   # only the live Temporal + Postgres suites (temporary database)
pnpm smoke              # end-to-end CLI flow with a temporary signing key
```

## Security expectations

- **Prompt instructions are not security boundaries.** Access restrictions (filesystem, network, credentials, budgets) must be enforced outside the model.
- Never commit `.env`, credentials, private signing keys, runtime task outputs, logs, or artifacts. Profiles reference env var NAMES only.
- Never log secrets; redact before persisting. No Docker socket mounted into ordinary agent containers; document any privileged sandbox manager explicitly.
- Pin container image versions (no `latest`) and GitHub Actions to commit SHAs.
