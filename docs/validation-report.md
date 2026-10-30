# Validation report (milestone 1)

Date: 2026-10-30. Host: Linux 6.2, Docker 29.3.1.

## Versions

Node 22.12.0, pnpm 9.9.0, TypeScript 5.9.3, Vitest 5.0.5, ESLint 9, Prettier 3.x, Zod 3.25.x, @temporalio/\* 1.25.0, pg 8.x, pino 9.x, `temporalio/temporal:1.9.1`, `postgres:16.15-alpine`.

## Results

| Check                                                                                                   | Command                          | Outcome |
| ------------------------------------------------------------------------------------------------------- | -------------------------------- | ------- |
| Clean install from lockfile (node_modules and dist removed first)                                       | `pnpm install --frozen-lockfile` | passed  |
| Formatting                                                                                              | `pnpm format:check`              | passed  |
| Lint                                                                                                    | `pnpm lint`                      | passed  |
| Typecheck                                                                                               | `pnpm typecheck`                 | passed  |
| Unit tests (33: contracts, redaction, task store idempotency/path safety, mock executor, profile guard) | `pnpm test`                      | passed  |
| Build                                                                                                   | `pnpm build`                     | passed  |
| Compose up with health checks (Postgres, Temporal dev server), loopback ports                           | `pnpm infra:up`                  | passed  |
| Migrations (applied, then re-run is a no-op)                                                            | `pnpm db:migrate`                | passed  |
| Doctor                                                                                                  | `pnpm doctor`                    | passed  |
| End-to-end smoke (13 assertions)                                                                        | `pnpm smoke`                     | passed  |

The smoke test (mock mode, no API keys) verifies: both runs pause at `WAITING_FOR_HUMAN_APPROVAL`; an agent-sourced approval signal does not unblock the workflow; after killing and restarting the worker the workflow is still queryable; human approve finishes `APPROVED` and human reject finishes `REJECTED`; a late duplicate decision changes nothing; Postgres status and task file agree with the final status; exactly 2 results and 1 human approval per run with no duplicates.

Also checked manually: duplicate `approve` on a finished run prints "already decided" and changes nothing.

## Limitations / not verified

- Activity-retry idempotency is covered by unit tests (task store) and DB constraints (`ON CONFLICT`), not by fault injection against a live Temporal Activity retry.
- OpenHands is not integrated: no Compose service, no requests (see `docs/architecture.md`). Real execution mode fails explicitly.
- GitHub Actions workflow is unverified until it runs on GitHub.
- The Temporal dev server is development-only; its SQLite store is not suitable for production.
- No paid LLM calls, cloud resources, product repository, or deployment were created.
