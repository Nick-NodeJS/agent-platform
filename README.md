# agent-platform

Reusable orchestration engine for an AI agent department (TypeScript, pnpm monorepo, Temporal, PostgreSQL).
Milestone 1: infrastructure, contracts, and an executable **mock** workflow. No paid LLM calls.

Contributors and agents: read the [code quality policy](docs/code-quality.md) first.

See [docs/project-state.md](docs/project-state.md), [docs/architecture.md](docs/architecture.md), [docs/local-development.md](docs/local-development.md), [docs/validation-report.md](docs/validation-report.md), and [AGENTS.md](AGENTS.md).

## Quick start

Requires Node 22.12.0 (`.nvmrc`), pnpm 9.9.0, Docker.

```sh
nvm use                      # or any Node 22.12.0
pnpm install --frozen-lockfile
cp .env.example .env         # dummy dev values, no API keys needed
pnpm build
pnpm infra:up                # Postgres (127.0.0.1:5433) + Temporal dev server (7233, UI http://127.0.0.1:8233)
pnpm db:migrate
pnpm cli approval-keygen --actor <your-name>   # one time; keys go OUTSIDE the repo (default ~/.config/agent-platform/approval/)
# put the printed APPROVAL_TRUSTED_SIGNERS_FILE=... line (PUBLIC keys only) in .env
pnpm doctor
pnpm worker:start            # keep running in its own terminal
```

`approval-keygen` never runs automatically and refuses to write inside the repo or overwrite existing keys.
The private signer file (`signer.json`) belongs to the trusted human CLI only: do not put it in `.env`, the worker environment, or any agent mount.

## Run the mock workflow

```sh
pnpm cli start --goal "Find a small B2C product idea" --run-id run-demo-1 --budget-usd 500 --team-size 2
pnpm cli status run-demo-1                       # pauses at WAITING_FOR_HUMAN_APPROVAL and shows the review gate
pnpm cli approve run-demo-1 --reason "looks fine"   # or: pnpm cli reject run-demo-1 --reason "no"
pnpm cli status run-demo-1
```

`approve`/`reject` sign the decision (Ed25519) for the current review gate and exact result digests, then submit it as a
Temporal Update. If the gate is not open yet, the decision was rejected (stale, wrong run, expired, replayed, bad signature),
the CLI prints why and exits non-zero. Nothing is buffered for later. This authorizes a trusted human-controlled signer; it is not
proof that a biological person clicked a button (see `docs/architecture.md`).

If an agent execution is left `uncertain` (it may have run but no result was stored), the run fails instead of silently re-running:

```sh
pnpm cli executions run-demo-1
pnpm cli reconcile run-demo-1 researcher --confirm-no-external-run   # operator decision; then start again with the same --run-id
```

Omitted constraints (`--budget-usd`, `--team-size`, `--timeline-weeks`, `--notes`) are recorded as `unknown`.
Task files are written to `.task-data/tasks/` (git-ignored). Execution history: Temporal UI.

## Commands

| Task                  | Command                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| Install               | `pnpm install --frozen-lockfile`                                                                     |
| Infra up / down       | `pnpm infra:up` / `pnpm infra:down` (data persists in named volumes)                                 |
| Migrations            | `pnpm db:migrate`                                                                                    |
| Worker                | `pnpm worker:start`                                                                                  |
| CLI                   | `pnpm cli <start\|status\|approve\|reject\|approval-keygen\|executions\|reconcile\|migrate\|doctor>` |
| Format / lint / types | `pnpm format` / `pnpm lint` / `pnpm typecheck`                                                       |
| Build / unit tests    | `pnpm build` / `pnpm test` (builds first; no infra needed)                                           |
| Integration tests     | `pnpm test:integration` (needs `pnpm infra:up`; uses its own temp database)                          |
| End-to-end smoke      | `pnpm smoke` (needs infra up + migrated)                                                             |
