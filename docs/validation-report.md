# Validation report

Date: 2026-10-30. Host: Linux 6.2 (local filesystem, ext4-class), Docker 29.3.1. Baseline reviewed: `de14db7`; this report covers the four-fix change on top of it.

## Versions

Node 22.12.0, pnpm 9.9.0, TypeScript 5.9.3, Vitest 5.0.5, ESLint 9, Prettier 3.x, Zod 3.25.x, @temporalio/\* 1.25.0, pg 8.x, pino 9.x, proper-lockfile 4.1.2, `temporalio/temporal:1.9.1`, `postgres:16.15-alpine`.

## Executed and passed

| Check                                                                     | Command                                  | Result                     |
| ------------------------------------------------------------------------- | ---------------------------------------- | -------------------------- |
| Clean install (node_modules and dist removed first)                       | `pnpm install --frozen-lockfile`         | passed                     |
| Formatting / lint / typecheck (incl. `tests/`)                            | `pnpm format:check`, `lint`, `typecheck` | passed                     |
| Unit tests (builds first)                                                 | `pnpm test`                              | 50 tests in 5 files passed |
| Build                                                                     | `pnpm build`                             | passed                     |
| Migrations on the existing dev database (additive `002`), re-run is no-op | `pnpm db:migrate`                        | passed                     |
| Live Temporal + Postgres integration suites (temporary DB, dropped after) | `pnpm test:integration`                  | 14 tests in 2 files passed |
| End-to-end CLI smoke with a temporary signing key outside the repo        | `pnpm smoke`                             | 15 assertions passed       |

After the integration run no `platform_it_*` databases and no test-owned worker/child processes remained. Existing dev volumes and databases were not reset; existing workflow histories were not deleted.

## What each fix is verified by (actually executed)

1. **Current-gate approvals.** Integration: early decision rejected and not buffered; the gate appears only after results are in Postgres and the task file and the waiting status is projected; malformed/unsigned/forged/tampered/wrong-signer/expired/wrong-gate/wrong-run/stale-artifact/replayed decisions change nothing; a valid approve and a valid reject complete the correct gate; racing approve/reject/duplicate admits exactly one; a decision submitted while no worker is running is processed after a worker restart; an approval for previous artifact digests cannot approve changed results. Smoke: forged `source: human` update rejected; worker restart while waiting; CLI duplicate decision reports "already decided".
2. **Signed approvals.** Unit (ephemeral generated keys): valid signature accepted; unsigned/forged, altered content, wrong or untrusted key, actor not matching the trusted signer config, expired/future/over-long windows, wrong run/gate/artifacts rejected. Integration and smoke use the signed path end to end. The worker refuses to start if `APPROVAL_SIGNER_FILE` is set.
3. **Execution durability.** Integration with a counting executor and real Temporal Activity retries: failure before task projection, failure after the Activity body, and transient persistence failure all keep the executor call count at 1; a persistent persistence failure ends `uncertain` (count 1, no result stored), and an explicit reconcile + re-run records 2 attempts; a fresh workflow start with the same run ID reuses stored results (count unchanged); 5 concurrent attempts start the executor once; stale fenced attempts cannot overwrite or invoke; an invoked-but-abandoned lease becomes `uncertain`; a changed input for an existing stage is refused; executor errors are `uncertain`, definitive "not started" errors are not counted.
4. **Task file locking.** Unit with child processes: concurrent creation; concurrent result/approval/status writes from 14 processes keep every update; SIGKILL of a lock holder (after the JSON write, before Markdown) is recovered after the stale window with no duplicates and a rebuilt Markdown; bounded timeout while a live holder exists; exception releases the lock; Markdown rebuild from JSON; status ordering; per-task locks in one process.

## Limitations / not verified

- Isolation of agents (containers, networks, key access) is a documented plan only. Signing does not protect against an agent running as the approver's OS user. Not proof that a biological person approved.
- Task-file locking assumptions: local POSIX filesystem, sane clocks; not tested on NFS/SMB or under clock jumps. A live process stalled longer than the stale window can lose its lock (detected before writing, not prevented).
- Exactly-once external billing cannot be guaranteed by Postgres; real idempotency depends on the provider/runtime. Only the mock executor was exercised.
- Integration tests and smoke need Docker infra and are not run in GitHub Actions; CI runs install, format, lint, typecheck, unit tests and build. The CI workflow has not been observed running on GitHub for this change.
- Workflows started before this change are not replay-compatible with the new workflow code (documented: start new runs).
- No paid LLM calls, cloud resources, OpenHands integration, product repository, or deployment.
