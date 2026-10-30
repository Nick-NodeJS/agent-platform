# AGENTS.md

## Scope

Platform repository: reusable orchestration engine and shared packages (pnpm monorepo, TypeScript only).
Product repositories are created later, only after research, business-owner evaluation, and explicit human approval.
Milestone 1 = infrastructure, contracts, and an executable **mock** workflow. No paid model calls, cloud resources, or product repos.

## Architecture rules

- Temporal owns durable execution, retries, approval waits, recovery. PostgreSQL owns business records and cost accounting.
- Workflows (`apps/worker/src/workflows`) must be deterministic: no filesystem, DB, network, random IDs, or agent calls. Those belong in Activities.
- Activities must be idempotent (stable IDs, `ON CONFLICT`), with bounded retries/timeouts. Pass artifact references, not full transcripts/secrets, through Temporal payloads.
- Agent approval and human approval are different events. Only `source: 'human'` can pass the approval gate; label sources honestly.
- Real execution must never silently fall back to mock; unconfigured profiles are rejected at the executor boundary (`assertProfileConfigured`).
- Task storage goes through the `TaskStore` interface (local files now, Jira later). Execution goes through `AgentExecutor` (mock now, OpenHands later).
- Do not add packages/services without a real responsibility; mark deferred integrations clearly.

## Verification commands

```sh
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm infra:up && pnpm db:migrate && pnpm smoke   # end-to-end, needs Docker
```

## Security expectations

- **Prompt instructions are not security boundaries.** Access restrictions (filesystem, network, credentials, budgets) must be enforced outside the model.
- Never commit `.env`, credentials, runtime task outputs, logs, or artifacts. Profiles reference env var NAMES only.
- Never log secrets; redact before persisting. No Docker socket mounted into ordinary agent containers; document any privileged sandbox manager explicitly.
- Pin container image versions (no `latest`) and GitHub Actions to commit SHAs.
