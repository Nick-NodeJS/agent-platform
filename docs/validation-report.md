# Validation report

Date: 2026-10-30. Host: Linux 6.2 (local filesystem, ext4-class), Docker 29.3.1. Baseline reviewed: `de14db7`; this report covers the four-fix change on top of it.

## Versions

Node 22.12.0, pnpm 9.9.0, TypeScript 5.9.3, Vitest 5.0.5, ESLint 9, Prettier 3.x, Zod 3.25.x, @temporalio/\* 1.25.0, pg 8.x, pino 9.x, fs-ext 2.1.1 (node-gyp 10.3.1), `temporalio/temporal:1.9.1`, `postgres:16.15-alpine`.

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

## Code-quality change (policy, enforcement, coverage)

Executed on 2026-10-30 after a clean `pnpm install --frozen-lockfile` (node_modules and dist removed first):

| Check                                                            | Result                                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` | passed (lint is type-aware and now covers tests, scripts, fixtures) |
| `pnpm test` (unit, no infra)                                     | 74 tests passed                                                     |
| `pnpm test:coverage` (unit + live integration, 12 files)         | 108 tests passed; thresholds met                                    |
| `pnpm smoke` (compiled TypeScript script)                        | 15 assertions passed                                                |

Coverage (V8, repository-wide, `coverage/coverage-summary.json`): **lines 87.83%, branches 80.77%**, statements 87.41%,
functions 88.29% (floor: 80% lines and 80% branches). Baseline before this work, measured honestly on the same scope
with the refactored CLI untested: 55.55% lines / 49.87% branches.

- Measured scope: `packages/*/src` and `apps/*/src` (unit + in-process integration tests). Files never loaded are in the denominator.
- Excluded: test files, `*.d.ts`, `dist/`, `**/fixtures/**` (child-process fixture entry points).
- Not instrumented (behavior is tested but not counted): workflow code (Temporal sandbox bundle; it stays in the denominator
  at 0% line coverage), `main.ts` entry points of the CLI and worker (thin process glue, also in the denominator), the CLI/worker
  processes started by `pnpm smoke`, and the child processes of the cross-process `LocalTaskStore` tests.
- The branch margin is small (0.77 points). Coverage is evidence of execution, not correctness; critical scenarios have explicit tests.

Gaps found and fixed in the baseline: package-level test files were excluded from every tsconfig and were never typechecked;
the cross-process fixture was an untyped `.mjs` and the smoke test an untyped `.mjs` (both are now TypeScript, compiled and linted);
many control-flow statements had no braces; production code used non-null assertions, `as` casts and `any`-typed database
rows (rows are now parsed with Zod); the CLI was a single 400-line module (now `cli.ts` plus one module per command, run
in-process by tests); the executor contract used unchecked generics (now a typed role map, removing `as O`).
No inline shell-string programs were found.

Behavior changes (kept separate from cleanup): none intended. Two small deliberate ones: unreachable/unused code was removed
(`listTaskIds`, `nowIso`, an unreachable approval-version check), and `reuse` no longer silently substitutes zero usage when the
execution row is missing (it fails loudly).

CI (`.github/workflows/ci.yml`) now runs install, format, lint, typecheck, build, starts Postgres + Temporal from
`infra/compose.yaml` with dummy values, runs `pnpm test:coverage` (which already includes the unit suite, so it is not run twice) and
`pnpm smoke`, and uploads only `coverage/lcov.info` and `coverage/coverage-summary.json`. The workflow has not been observed
running on GitHub for this change.

### Remaining limitations

- CI needs Docker (Compose, the Temporal image) on the runner; it is unverified until it runs on GitHub.
- Workflow code and entry-point processes are not measured by coverage.
- Branch coverage is close to the floor; new code needs tests, not threshold changes.
- The policy is applied by context loading and tooling, not by prompts alone; no real coding agent exists yet to exercise `loadPolicyContext`.

## CI order and flock task locks

Executed on 2026-10-30 from a **clean temporary git worktree** of the commit (no `dist/`, no `*.tsbuildinfo`, no `node_modules`; the working
checkout and its data were not touched; the worktree was removed afterwards). Node 22.12.0, pnpm 9.9.0, Ubuntu with `build-essential` and Python 3.10.

| Check                                                             | Result                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` (builds `fs-ext` with node-gyp)  | passed; `fs_ext.node` present                                                                |
| `pnpm lint` BEFORE build (the previous CI order)                  | **failed with 1160 errors** (unresolved workspace types): reproduces the reported CI failure |
| `pnpm verify` (format check, build, lint, typecheck)              | passed                                                                                       |
| `pnpm test` (unit)                                                | 83 tests passed                                                                              |
| `pnpm db:migrate`, `pnpm test:coverage` (unit + live integration) | 117 tests passed; lines 87.93%, branches 80.30%, statements 87.75%, functions 88.83%         |
| `pnpm smoke`                                                      | 15 assertions passed                                                                         |

Lock regression tests (checked-in typed subprocess fixture, bounded readiness barriers): concurrent creation from 6 processes;
mixed result/approval/status writes from 14 processes with status ordering; **paused owner** (SIGSTOP after the temporary file is
written, before rename) keeps the lock past the former 2.5 s stale window, the contender times out, then SIGCONT lets the owner finish and
both updates remain; **killed owner** (SIGKILL) releases at once (no stale wait) and a kill between JSON and Markdown publication is
repaired without duplicates; exceptions release the lock; separate instances in one process contend while unrelated tasks do not;
the lock file keeps its inode and mode across contention and no descriptors leak; lock-free readers see only complete snapshots while
writers publish; unsupported platforms fail with `UnsupportedPlatformError` before any lock file is created.

Limitations: Linux and local filesystems only (not tested on NFS/SMB, macOS or Windows; those are unsupported by design); the lock is
advisory; JSON and Markdown publication is not one atomic transaction and nothing is fsynced; the branch-coverage margin over the 80%
floor is 0.3 points. The GitHub Actions run for the pushed SHA is reported separately after the push.

## Step 1: architecture review and documentation

Reviewed commit: `71dcfbc2a08ecd5e6e665ab88b3a2e552afc684e` (local `master` and `origin/master` were identical at the start; no newer
changes existed). Deliverables: `docs/architecture/{overview,workflows,modules,security}.md`, `docs/decisions/` (index and five ADRs),
`docs/architecture.md` as a landing page, README reading order, an `AGENTS.md` rule, and the roadmap in `docs/project-state.md`.
No application code, tests or dependencies were changed.

### How each kind of claim was supported

| Support                                                        | What it covers in the new documents                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source inspection (this session)**                           | Workflow states and API names, Activity order, authority of Postgres/JSON/Markdown, execution states, CLI commands and output labels, config, what is unused or stubbed, ignored files                                                                                                              |
| **Published CI result**                                        | CI run #4 for the exact SHA `71dcfbc` completed with `success` (https://github.com/Nick-NodeJS/agent-platform/actions/runs/41075674749; status read through the unauthenticated GitHub API this session). It runs `pnpm verify`, `pnpm test:coverage` and `pnpm smoke`; the step logs were not read |
| **Tests run by me in the previous milestone (earlier report)** | Results quoted in the sections above (83 unit, 117 total tests, 87.93% lines / 80.30% branches, 15 smoke assertions) were produced from a clean worktree of the same source; they were **not** re-run for this documentation change                                                                 |
| **Tests run in this milestone**                                | Only the documentation checks below                                                                                                                                                                                                                                                                 |

### Checks run for this milestone

| Check                                                                                                                                                                                          | Result                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| All relative links in `docs/**/*.md`, `README.md`, `AGENTS.md` (153 links, targets and anchors)                                                                                                | passed                                                                                |
| Referenced symbols exist in source (about 45 names such as `checkDecisionAgainstGate`, `runAgentStage`)                                                                                        | passed                                                                                |
| CLI commands in examples compared with `USAGE` in `apps/cli/src/cli.ts`                                                                                                                        | consistent (examples with side effects were not re-run)                               |
| Mermaid syntax of all 5 diagrams, parsed with `mermaid@11` + `jsdom` in a temporary directory outside the repository (no dependency added; the checker was shown to reject an invalid diagram) | 5/5 parsed. **Not visually rendered**; GitHub rendering and layout were not inspected |
| `pnpm format:check`, `pnpm verify` (format check, build, lint, typecheck)                                                                                                                      | passed, run after the last edit                                                       |

### Review findings (not fixed in this change)

| #   | Severity                    | Finding and impact                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence (source inspection; not reproduced)                                                                                                                                                                |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Medium                      | Restarting an **already decided** run ID with `start --run-id` opens the same gate again. A second valid signed decision is accepted by the workflow and reported in its result, but Postgres keeps the first approval (`ON CONFLICT DO NOTHING`) and statuses stay terminal, so the Temporal result can contradict Postgres and the task file. Needs an explicit restart plus a valid signature; use a new run ID meanwhile | `apps/worker/src/workflows/index.ts` (`recordDecision` result `stored` ignored; `state.decision` built from the envelope); `RunRepository.insertApproval`; unique `run_id` on `approvals` in `001_init.sql` |
| F2  | Medium (before real agents) | Activity timeout is 1 minute while the execution lease is 2 minutes and Activities do not heartbeat or receive cancellation. A real model call longer than a minute would time out, retry into `ExecutionInProgress`, or end `uncertain`. The mock is unaffected                                                                                                                                                             | `ACTIVITY_TIMEOUT` in `workflows/index.ts`; `withLeaseRenewal` and `DEFAULT_AGENT_LEASE_TTL_MS`; `executor.run` receives no abort signal                                                                    |
| F3  | Low                         | `TASK_STORE_DIR` defaults to a path relative to each process's working directory. A CLI started from another directory silently prints no results (`getResults` returns an empty list for a missing file) and `doctor` does not check it                                                                                                                                                                                     | `config.ts` default; `LocalTaskStore` constructor (`path.resolve`); `status.ts`                                                                                                                             |
| F4  | Low                         | `@platform/agents` is a declared dependency of `apps/cli` and `apps/worker` but is not imported there. Role instructions, model profiles, budgets and `loadPolicyContext` have no runtime effect yet                                                                                                                                                                                                                         | `apps/*/package.json`; no import of `@platform/agents` under `apps/*/src`                                                                                                                                   |
| F5  | Info                        | `EXECUTION_MODE=openhands` lets the worker start (warning only); the workflow fails at the first agent stage. `OPENHANDS_*` variables are validated but never read                                                                                                                                                                                                                                                           | `apps/worker/src/main.ts`, `config.ts`, `OpenHandsAgentExecutor`                                                                                                                                            |
| F6  | Info                        | No replay test exists, so history compatibility across commits is unverified (documented in [workflows](architecture/workflows.md))                                                                                                                                                                                                                                                                                          | `apps/worker/src/workflows/index.ts`; no `patched()` use                                                                                                                                                    |

### Limitations of this milestone

- Diagrams were syntax-checked, not rendered. The new pages were not reviewed by anyone else yet.
- Behavior descriptions come from source inspection and earlier test results as labelled above; the full Docker suite was not repeated.
- The CI status above is for `71dcfbc`; the documentation commit has not been pushed or observed in CI by this report.
