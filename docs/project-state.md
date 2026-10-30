# Project state

## Agreed decisions

- Platform repo = reusable engine + shared packages (pnpm monorepo). Product repos come later, after research, business-owner evaluation, and explicit human approval.
- All custom code is TypeScript. OpenHands may run Python as a separate service.
- Temporal: durable execution, retries, approval waits. PostgreSQL: business records and cost accounting.
- OpenHands: agent execution/workspaces via its API (deferred). Per-role provider/model/instructions/tools/budgets.
- Task adapter: local files now, Jira later. GitHub owns code/PRs; CI/CD owns deployment.
- Agent approval and human approval are different events. Public launch and over-limit spend need human approval.
- The owner's market, budget, and acquisition assumptions are NOT decided; they are recorded as `unknown`.

## Milestone 1 - completed scope

Monorepo, contracts, local task store, mock executor, Postgres persistence + migrations, Temporal worker, `researchProposalWorkflow`, CLI, Compose infra, CI, docs. See `docs/validation-report.md` for what was actually verified.

## Review-fix scope (four findings from the milestone-1 review)

1. Approvals only for the current review gate (Update + validator, gate bound to artifact IDs/digests, no buffering).
2. Human approval is a verifiable Ed25519-signed envelope from a trusted human-controlled signer (not a string claim).
3. Durable, fenced agent executions: reuse on retry, `uncertain` instead of blind re-runs, actual attempt accounting.
4. Cross-process task file locking with forward-only status ordering and rebuildable Markdown (now kernel `flock`, no stale-time lease).

## Code-quality scope

Policy in `docs/code-quality.md` (linked from `AGENTS.md` and `README.md`), enforced by type-aware ESLint (no suppression
comments), a typecheck covering tests/scripts/fixtures, Vitest coverage thresholds (80% lines / 80% branches, measured
87.83% / 80.77%) and CI. A bounded readability pass split the CLI into commands, typed the executor contract, parsed database rows
and converted the smoke script and child-process fixture to TypeScript. `loadPolicyContext` (`@platform/agents`) is the explicit path
for giving the policy to future platform-spawned coding/review agents.

## Unresolved / blockers

- OpenHands Agent Server container setup not verified; no Compose service (see `docs/architecture.md`).
- No real model execution; model profiles are placeholders.
- Container/network/user isolation for agents is a documented plan only (`docs/architecture.md`); it must be enforced before any real agent execution. Signing does not protect against an agent running as the approver's OS user.
- Exactly-once billing cannot be guaranteed by Postgres alone; external idempotency depends on the provider/runtime.
- The local task store is Linux/local-filesystem only (`flock` via `fs-ext`; native build needs `build-essential` + `python3`); no NFS/SMB, no multi-host coordination. The lock is advisory.
- `pnpm test:coverage`, `pnpm test:integration` and `pnpm smoke` need Docker infra; CI starts it from `infra/compose.yaml` (unverified on GitHub until the next run).
- Workflow code and process entry points are not counted by coverage; the branch-coverage margin over the 80% floor is under one point.
- Pre-change workflow histories are not replay-compatible (start new runs).

## Next milestone

Real researcher + business-owner execution, search tools, and owner-supplied resource constraints.

## Sources and versions

- https://docs.temporal.io/develop/typescript, https://docs.temporal.io/cli (`temporal server start-dev`), https://github.com/temporalio/samples-server/tree/main/compose
- https://github.com/OpenHands/software-agent-sdk, https://docs.openhands.dev/sdk, https://pnpm.io/workspaces
- Validated: Node 22.12.0, pnpm 9.9.0, @temporalio/\* 1.25.0, temporalio/temporal 1.9.1, postgres 16.15-alpine, TypeScript 5.9.3, Zod 3.25.x.
