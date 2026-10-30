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

## Unresolved / blockers

- OpenHands Agent Server container setup not verified; no Compose service (see `docs/architecture.md`).
- No real model execution; model profiles are placeholders.
- Activity-retry idempotency is covered by unit tests and DB constraints, not by fault injection against a live Temporal.

## Next milestone

Real researcher + business-owner execution, search tools, and owner-supplied resource constraints.

## Sources and versions

- https://docs.temporal.io/develop/typescript, https://docs.temporal.io/cli (`temporal server start-dev`), https://github.com/temporalio/samples-server/tree/main/compose
- https://github.com/OpenHands/software-agent-sdk, https://docs.openhands.dev/sdk, https://pnpm.io/workspaces
- Validated: Node 22.12.0, pnpm 9.9.0, @temporalio/\* 1.25.0, temporalio/temporal 1.9.1, postgres 16.15-alpine, TypeScript 5.9.3, Zod 3.25.x.
