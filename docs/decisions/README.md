# Architecture decision records

Short records of decisions that shape the platform. ADRs 1-4 record **existing** choices **retrospectively**: they were made during
the bootstrap and review milestones and are written down here from the agreed decisions in [project state](../project-state.md) and the
code. They carry no historical dates or reasoning beyond what those sources and the code show. ADR 5 is an **accepted direction
whose implementation is pending**.

| ADR                                                  | Decision                                                         | Status                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| [0001](0001-typescript-monorepo-separate-repos.md)   | TypeScript monorepo; separate platform and product repositories  | Accepted (implemented)                     |
| [0002](0002-temporal-postgres-local-task-adapter.md) | Temporal plus PostgreSQL; local task adapter                     | Accepted (implemented)                     |
| [0003](0003-signed-approval-gates.md)                | Signed approval gates and explicit trust boundaries              | Accepted (implemented)                     |
| [0004](0004-linux-flock-local-file-backend.md)       | Linux kernel `flock` for the local file backend                  | Accepted (implemented)                     |
| [0005](0005-direct-api-research-first.md)            | Local sequential direct-API research first; OpenHands for coding | Accepted direction; implementation pending |

When to write one: a change to behavior, contracts, persistence, permissions or deployment that **changes a decision** needs a new ADR
(or a status change here) and an update to the matching [architecture page](../architecture/overview.md). Purely cosmetic edits do not.
Keep each ADR short: status, context, decision, consequences, source pointers. Do not edit an accepted ADR's decision; supersede it with a new one.
