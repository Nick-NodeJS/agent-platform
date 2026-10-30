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

| #   | Severity                                                    | Finding and impact                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence (source inspection; not reproduced)                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Medium (**fixed** in the F1 final-review change, see below) | Restarting an already decided run ID could open the same gate again and report a second signed decision that Postgres ignored. Original evidence: `recordDecision` result ignored in `apps/worker/src/workflows/index.ts`; `insertApproval ... ON CONFLICT DO NOTHING`; unique `run_id` on `approvals`. **Now** enforced by the CLI start policy, a Postgres guard and transactional canonical decision persistence; evidence in the F1 section below |
| F2  | Medium (before real agents)                                 | Activity timeout is 1 minute while the execution lease is 2 minutes and Activities do not heartbeat or receive cancellation. A real model call longer than a minute would time out, retry into `ExecutionInProgress`, or end `uncertain`. The mock is unaffected                                                                                                                                                                                      | `ACTIVITY_TIMEOUT` in `workflows/index.ts`; `withLeaseRenewal` and `DEFAULT_AGENT_LEASE_TTL_MS`; `executor.run` receives no abort signal                                                                                      |
| F3  | Low                                                         | `TASK_STORE_DIR` defaults to a path relative to each process's working directory. A CLI started from another directory silently prints no results (`getResults` returns an empty list for a missing file) and `doctor` does not check it                                                                                                                                                                                                              | `config.ts` default; `LocalTaskStore` constructor (`path.resolve`); `status.ts`                                                                                                                                               |
| F4  | Low                                                         | `@platform/agents` is a declared dependency of `apps/cli` and `apps/worker` but is not imported there. Role instructions, model profiles, budgets and `loadPolicyContext` have no runtime effect yet                                                                                                                                                                                                                                                  | `apps/*/package.json`; no import of `@platform/agents` under `apps/*/src`                                                                                                                                                     |
| F5  | Info                                                        | `EXECUTION_MODE=openhands` lets the worker start (warning only); the workflow fails at the first agent stage. `OPENHANDS_*` variables are validated but never read                                                                                                                                                                                                                                                                                    | `apps/worker/src/main.ts`, `config.ts`, `OpenHandsAgentExecutor`                                                                                                                                                              |
| F6  | Info                                                        | No replay test exists, so history compatibility across commits is unverified (documented in [workflows](architecture/workflows.md))                                                                                                                                                                                                                                                                                                                   | `apps/worker/src/workflows/index.ts`; no `patched()` use (partly addressed in the F1 change: a permanent replay test was added and 118 of 125 local histories were replayed once; cross-commit replay is still not automated) |

### Limitations of this milestone

- Diagrams were syntax-checked, not rendered. The new pages were not reviewed by anyone else yet.
- Behavior descriptions come from source inspection and earlier test results as labelled above; the full Docker suite was not repeated.
- The CI status above is for `71dcfbc`; the documentation commit has not been pushed or observed in CI by this report.

## F1 final review fixes (2026-10-30)

Baseline: `27ba773bf2f299b22a99d9a57ea0a1a181a6dbf9` (local and `origin/master` were identical). Scope: F1 and two documentation corrections; F2-F6 stay open
(F2 must be resolved before real model execution).

**Behavior changed.** One logical run ID has one immutable human decision.
(1) `pnpm cli start` sets `WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY` and `WorkflowIdConflictPolicy.FAIL`; a running or completed run is refused with an
actionable error. (2) `createTaskAndRun` and `openReviewGate` call `assertRunNotDecided` (Postgres decision or terminal status) and fail non-retryably with `RunAlreadyDecided`.
(3) `RunRepository.recordDecision` stores the decision and closes the gate in one transaction serialized by a `runs` row lock, returns the canonical stored approval,
treats an identical decision as an idempotent retry and raises `DecisionConflictError` (Activity: non-retryable `DecisionConflict`) for anything different, including a decision
ID used by another run. The Activity projects only the stored approval and the workflow takes its final status and decision from it. The change to the workflow is
guarded with `patched('canonical-stored-decision')`. `insertApproval`/`closeGate` were removed; no migration was needed (the schema already had unique `run_id` and `decision_id`).

**Tests added or changed (all executed in this milestone).**

| Requirement                                                                                                          | Test (file)                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Approve and reject runs cannot be restarted via the CLI; history, decision, task, executions unchanged               | `run-identity.integration.test.ts` (parameterized for approve and reject)                                                     |
| Starting while the run is active creates no second execution                                                         | same file                                                                                                                     |
| Direct start with explicit `ALLOW_DUPLICATE` cannot re-decide; no agent calls; results/projection unchanged          | same file                                                                                                                     |
| Postgres alone rejects reuse with no Temporal history (decision row, and terminal status only)                       | same file (no real history deleted)                                                                                           |
| Failed, undecided run restarts with the same ID and reuses stages; no duplicated execution                           | same file, plus the existing reconcile-and-restart test in `executions.integration.test.ts` (now started with the CLI policy) |
| Persistence succeeded, projection failed, retry reuses the exact approval and repairs the file                       | same file (injected task-store failure, `recordDecision` called at least twice, one row)                                      |
| Conflicting decision: non-retryable `DecisionConflict`, all decisions stay consistent                                | same file (Activity level) and `persistence.integration.test.ts`                                                              |
| Concurrent repository attempts serialize on the run row                                                              | `persistence.integration.test.ts` (7 concurrent attempts: one created, matching ones identical, rivals conflict)              |
| Workflow output, Postgres approval/run status and task JSON agree on decision, signer and decision ID                | `expectConsistentDecision` in `run-identity.integration.test.ts`                                                              |
| Legacy approval without signer identity still protects the run ID                                                    | `persistence.integration.test.ts`                                                                                             |
| Activity paths: guards at both entry points, malformed envelope, missing inputs, legacy digest, retryable DB failure | `activities.integration.test.ts`                                                                                              |
| Replay safety                                                                                                        | permanent replay test in `run-identity.integration.test.ts`; one-off replay below                                             |

**Replay evidence (one-off, local dev server, not committed).** All 125 completed `researchProposalWorkflow` histories were replayed against the new workflow bundle:
118 passed, including histories recorded by earlier commits (signed-Update era onward) whose `recordDecision` returned `{ stored }`; the 7 that failed were exactly the runs started before
the signed-Update change (2026-10-30 10:44-11:08), which were already documented as not replay-compatible. No history was deleted or relabeled.
A latent problem found on the way: completed workflows are replayed for Queries, so an unpatched change would have broken `pnpm cli status` for old runs.

**Checks run for this change** (local checkout, Node 22.12.0, Ubuntu; `fs-ext` build prerequisites installed):

| Check                                                             | Result                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                  | passed (lockfile unchanged)                                                                                                 |
| `pnpm verify` (format check, build, lint, typecheck)              | passed                                                                                                                      |
| `pnpm test` (unit)                                                | 83 tests in 9 files passed                                                                                                  |
| `pnpm db:migrate`; `pnpm test:coverage` (unit + live integration) | 137 tests in 15 files passed; **88.51% lines, 82.70% branches** (statements 88.31%, functions 88.66%); thresholds 80/80 met |
| `pnpm smoke`                                                      | 15 assertions passed                                                                                                        |

The first coverage run of this change measured 79.68% branches (below the floor) because the new code added branches; the floor was kept, defensive optional branches were removed
by tightening types (`StoredApproval`), and meaningful tests were added (`activities.integration.test.ts`, legacy-row and reason tests). One timing-dependent assertion in `file-lock.test.ts`
(which contender enters first) was found flaky under load and now uses a readiness barrier.

**Coverage accounting correction.** The earlier wording "not counted by coverage" for workflow code and entry points meant "not instrumented". Current facts from `vitest.coverage.config.ts` and
`coverage/lcov.info`: `apps/worker/src/workflows/index.ts` (62 lines, 15 branches), `apps/worker/src/main.ts` (18 lines, 8 branches) and `apps/cli/src/main.ts` (3 lines, 2 branches) are in the denominator and
reported uncovered; test files, `*.d.ts`, `dist/` and `**/fixtures/**` are excluded; subprocess executions are not instrumented. Thresholds are unchanged.

**Compatibility and limits.** Runs whose decision was stored but whose workflow failed before the final status projection are treated as decided and cannot be restarted with the same ID. The `patched()` marker must stay until no history without it can still be replayed.
`DecisionAck` means "accepted for processing", not durable completion. Not run: CI for the new SHA (not pushed from this environment unless stated in the final report).
