# Code quality policy

This is the repository policy for humans and for coding/review agents. Mechanical rules are enforced by tooling
(table below); the rest is judgment applied in review. No document guarantees SOLID compliance or overall quality:
human review and CI remain necessary.

Read this before changing code. After a change, report which of the checks below apply and their results.

## How it is enforced

| Rule                                                                              | Enforced by                                                      |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Formatting (the only formatter)                                                   | Prettier: `pnpm format:check` (`.prettierrc.json`)               |
| Strict types, `noUncheckedIndexedAccess`, tests/scripts/fixtures typechecked      | `tsc -b` + `tsc -p tsconfig.check.json` (`pnpm typecheck`)       |
| No `any`, non-null assertions, unsafe type assertions, floating/misused promises  | ESLint type-aware rules (`eslint.config.js`, `pnpm lint`)        |
| No suppression comments (`eslint-disable`, `@ts-ignore`, `@ts-nocheck`)           | `noInlineConfig` + `@typescript-eslint/ban-ts-comment`           |
| Braces for control flow, one statement per line, `===`, no empty blocks           | ESLint `curly`, `max-statements-per-line`, `eqeqeq`, `no-empty`  |
| No `console` in services (structured `pino` logs); allowed in CLI, scripts, tests | ESLint `no-console` with a narrow override                       |
| Behavioral regressions                                                            | Vitest unit + integration suites, smoke script                   |
| 80% line and 80% branch coverage floor (repository-wide)                          | `pnpm test:coverage` thresholds; CI                              |
| Workflow determinism/replay                                                       | Review + Temporal sandbox; integration tests run the real bundle |

Everything else below (naming, abstractions, comments, test quality) is a review responsibility.

Applicable checks to report after a change: `pnpm verify` (format check, build, lint, typecheck, in that order; lint and
typecheck resolve workspace types from built `dist/`), `pnpm test:coverage` (needs `pnpm infra:up`), and `pnpm smoke` when the
CLI, worker, workflow or persistence changed. `verify` does not run tests.

## Style and readability

Baseline: [Google's TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html), adapted for our
Node ESM / Temporal / pnpm stack. We do **not** claim full Google conformance. Deliberate deviations:

- **Formatting:** Prettier is the mechanical authority (single quotes, 100 columns, trailing commas), not Google's
  formatter defaults.
- **Module syntax:** Node ESM with explicit `.js` import specifiers (`NodeNext`); inline `type` imports.
- **Schema-derived types:** types inferred from Zod schemas are `type` aliases; hand-written object shapes use `interface`.
- **Tooling files:** `eslint.config.js` uses a default export because the tool requires it; application code uses named exports.
- **Docs:** JSDoc is not required on every export; comments are for decisions and constraints (see below).

Rules:

- Strict TypeScript. No unexplained `any`, unsafe casts, non-null assertions, or compiler/linter suppression.
  Parse unknown external values (JSON, env, CLI input, Temporal messages, DB rows, model/API output) instead of asserting a type.
- Descriptive domain names. Braces for every control-flow body, one executable statement per line. Format
  multiline objects/functions consistently (Prettier does this).
- Exported APIs have clear types; local values may rely on inference. Avoid redundant annotations.
- Named constants for meaningful timeout/retry/limit values, with units in the name (`LEASE_TTL_MS`,
  `ACTIVITY_MAX_ATTEMPTS`). Simple obvious literals do not need constants.
- Small cohesive functions, early returns, straightforward branching. A `switch` is fine for a finite command
  dispatcher; do not replace every conditional with a strategy registry.
- Group files by responsibility. There is no one-function-per-file rule and no line-count rule.
- Comments explain decisions, assumptions and non-obvious constraints; delete comments that restate the code.
- Tests, scripts and child-process fixtures are maintained code: typechecked and linted like production source.
  Substantial helper programs are checked-in TypeScript fixtures (for example
  `packages/integrations/src/fixtures/store-child.ts`), never code inside shell strings. A fixture that deliberately
  hangs or crashes must say why and be bounded and cleaned up by the parent test.
- Handle errors explicitly: no swallowed errors and no success-looking fallbacks. Where a failure is intentionally
  tolerated, say why in a comment. Services log through `pino` (structured, redacted); console output is for the CLI
  and for test/fixture process protocols.

## SOLID, simplicity and patterns

SOLID is design guidance for classes, functions and modules; it does not require an object-oriented framework.

- **Single responsibility:** keep workflow policy, persistence, external execution and presentation understandable
  and separable (for example `workflows/` orchestrates, `agent-stage.ts` owns execution durability, `commands/` own presentation).
- **Open/closed:** add stable extension points for real variants (`TaskStore`, `AgentExecutor`); do not prebuild plugins.
- **Liskov substitution:** adapter implementations honor the same behavioral contract, including failure and
  idempotency semantics (for example `ExecutorNotStartedError` means "definitely not started" for every executor).
  Share contract tests where it genuinely helps.
- **Interface segregation:** expose only what callers need; avoid large generic service interfaces.
- **Dependency inversion:** isolate external systems behind narrow contracts where substitution or ownership
  boundaries matter. Pass dependencies as explicit constructor/function arguments; no DI container without a demonstrated need.
- KISS and YAGNI: the simplest implementation that meets current requirements. Remove speculative layers and hierarchies.
- An interface with a single implementation is fine at a real boundary (`TaskStore`, `AgentExecutor`); do not add one per class.
- Use Adapter for external integrations, Strategy for real executor/storage alternatives, and an explicit state
  machine for workflow transitions when appropriate. Patterns are tools, not a checklist or quota.
- Extract duplication only when the shared concept is clear. A little repeated code beats an abstraction that couples unrelated behavior.
- New packages, wrappers, factories and generic frameworks need a concrete current reason, stated in the review.

## Type safety versus runtime validation

The compiler checks typed internal code. It does not validate JSON files, environment variables, CLI input, Temporal
messages, database payloads, or model/API responses.

- Validate at trust boundaries with the existing schemas; do not re-validate the same trusted internal object in every function.
- Use explicit object types or `satisfies` for compile-time shape checks. Do not claim TypeScript universally forbids
  extra properties: structural typing and excess-property checks differ by context.
- Do not write runtime tests solely to prove something the compiler already enforces. Dedicated type tests are only for
  intentional public typing contracts that normal compilation does not exercise.
- Runtime schema accept/reject tests are meaningful, including the unknown-key policy when it is part of the external contract.

## Testing and coverage

Tests must detect meaningful behavioral regressions: returned results, state transitions, persisted effects, rejected
unauthorized actions, retry/recovery behavior and resource cleanup. Ask of each new test: would a plausible incorrect
implementation fail it?

- Prefer small unit tests for pure logic; integration tests for Postgres/Temporal/filesystem boundaries; one compact
  end-to-end mock smoke script for the whole flow.
- Do not test private implementation details, trivial accessors, exact object keys already enforced only by internal
  typing, or mock-call choreography without a behavioral reason.
- Mock expensive/unavailable boundaries, not the behavior under test. Use real Postgres/Temporal and separate processes
  when the requirement is transactionality, replay or inter-process concurrency.
- Cover negative paths and boundaries: malformed input, early/stale/forged approvals, retries, uncertain execution,
  duplicate requests, crashes and concurrent file updates.
- Tests are deterministic, isolated and bounded, and clean up their own processes, files and databases. Prefer explicit
  readiness barriers and bounded polling over arbitrary sleeps. (A fixed wait is acceptable only to observe that
  something did _not_ happen, or to let a short lease expire; name the constant and say why.)

### Coverage floor

Project policy (not a Google mandate): **80% line and 80% branch coverage, repository-wide**, over maintained
application/library source, measured with the V8 provider by `pnpm test:coverage`. Thresholds are enforced in
`vitest.coverage.config.ts` and in CI.

- The run executes the unit tests and the in-process integration tests (live Temporal + Postgres from
  `pnpm infra:up`, using a temporary database that the tests drop). Source files that are never loaded are still counted in the denominator.
- **Excluded from the measurement:** test files, `*.d.ts`, build output (`dist/`), and `**/fixtures/**` (child-process
  fixture entry points, which run in separate processes). Tooling configuration (ESLint, Vitest, tsconfig) is not under `src/`.
- **Not instrumented, so not counted as measured coverage:** workflow code (it runs inside Temporal's isolated
  sandbox from a webpack bundle; it stays in the denominator and is exercised behaviorally by the integration tests),
  the separate CLI/worker processes started by `pnpm smoke`, and the child processes spawned by the cross-process
  `LocalTaskStore` tests. Their behavior is asserted by tests, but the percentage does not include it.
- Reach the floor with useful tests. Do not hide difficult files, lower thresholds, add blanket ignores, or pad
  assertions. If a material blocker prevents the target, report it and leave the check failing rather than weakening it.
- Coverage is evidence of execution, not correctness. Approval, budget, idempotency and concurrency requirements need
  explicit scenario tests regardless of the percentage. There is no automatic 100% target.

## Platform-specific constraints

- Temporal workflows stay deterministic: external I/O belongs in Activities. Respect compatibility/replay constraints when refactoring.
- Prompt instructions never substitute for permission, network or credential boundaries.
- Preserve the validated approval, recovery and concurrency fixes. Readability changes must not remove real fault-injection coverage.
- Keep dependencies focused; reuse existing tools; no broad unrelated upgrades.

## How agents receive this policy

`AGENTS.md` is not discovered automatically by every agent framework. Platform-spawned coding or review agents
must therefore be given the policy explicitly:

1. Executors that start such an agent call `loadPolicyContext(repoRoot)` from `@platform/agents`
   (`packages/agents/src/policy.ts`). It returns the text of `AGENTS.md` and this document plus a SHA-256 digest.
2. The executor places that text at the start of the agent's context and records the digest on the run, so a reviewer can see which policy version the agent received.
3. This is context loading, not enforcement. A model can still ignore text. The mechanical rules are enforced by
   ESLint/TypeScript/Vitest/CI on the resulting change, and permissions/network/credentials are enforced outside the model.

No real coding agent exists yet (milestone 1 is mock-only); this path must be used when one is added.

## Agent self-review before delivery

- Is the change easy to understand, and is each abstraction needed now?
- Are SOLID principles helping this design rather than creating boilerplate?
- Would a plausible incorrect implementation fail the new tests?
- Are compiler checks and runtime boundary tests serving distinct purposes?
- Do critical failure scenarios have real assertions, irrespective of the coverage number?
- Are test fixtures as readable and maintained as application code?
- Are secrets, permissions, workflow replay and retry semantics preserved?

## Sources

- Google TypeScript Style Guide: https://google.github.io/styleguide/tsguide.html
- Google code-review guidance (simplicity, over-engineering): https://google.github.io/eng-practices/review/reviewer/looking-for.html
- Google coverage guidance (no universal ideal percentage): https://testing.googleblog.com/2020/08/code-coverage-best-practices.html
- Vitest coverage: https://vitest.dev/guide/coverage.html
