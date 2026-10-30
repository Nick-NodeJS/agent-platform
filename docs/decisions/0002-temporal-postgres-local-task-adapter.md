# ADR 0002: Temporal plus PostgreSQL; local task adapter

**Status:** Accepted, implemented. Recorded retrospectively.

## Context

Runs must survive worker restarts, wait indefinitely for a human, retry failed steps and avoid repeating paid work. Business records
and cost accounting need a queryable store. Task tracking should start simple and be replaceable ([project state](../project-state.md)).

## Decision

- **Temporal** is the sole durable workflow coordinator: orchestration, retries, timers, the approval wait (an Update) and recovery. There is no second coordinator.
- **PostgreSQL** owns platform business records: runs, results, review gates, approvals, agent executions, events and costs. It does not duplicate Temporal history.
- Tasks go through the **`TaskStore`** interface. The only implementation is a local JSON file (canonical snapshot) with a derived Markdown view; Jira is a possible later adapter.
- GitHub owns code and pull requests and CI/CD owns deployment (future; neither is used for runs today).

## Consequences

- Two stores to keep consistent: Activities write Postgres first and project to files afterwards; retries repair projections ([overview](../architecture/overview.md) lists the authority of each store).
- Workflow code must stay deterministic and replay-compatible ([workflows](../architecture/workflows.md)).
- Local development needs Docker for Temporal and PostgreSQL; the Temporal dev server's SQLite store is development-only.

## Source pointers

[`workflows/index.ts`](../../apps/worker/src/workflows/index.ts), [`activities.ts`](../../apps/worker/src/activities.ts),
[`packages/persistence`](../../packages/persistence/src/index.ts), [`TaskStore` in `interfaces.ts`](../../packages/contracts/src/interfaces.ts),
[`compose.yaml`](../../infra/compose.yaml).
