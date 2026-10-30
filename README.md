# agent-platform

Reusable orchestration engine for an AI agent department (TypeScript, pnpm monorepo, Temporal, PostgreSQL).
Milestone 1: infrastructure, contracts, and an executable **mock** workflow. No paid LLM calls.

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
pnpm doctor
pnpm worker:start            # keep running in its own terminal
```

## Run the mock workflow

```sh
pnpm cli start --goal "Find a small B2C product idea" --run-id run-demo-1 --budget-usd 500 --team-size 2
pnpm cli status run-demo-1                       # pauses at WAITING_FOR_HUMAN_APPROVAL
pnpm cli approve run-demo-1 --reason "looks fine"   # or: pnpm cli reject run-demo-1 --reason "no"
pnpm cli status run-demo-1
```

Omitted constraints (`--budget-usd`, `--team-size`, `--timeline-weeks`, `--notes`) are recorded as `unknown`.
Task files are written to `.task-data/tasks/` (git-ignored). Execution history: Temporal UI.

## Commands

| Task                  | Command                                                              |
| --------------------- | -------------------------------------------------------------------- |
| Install               | `pnpm install --frozen-lockfile`                                     |
| Infra up / down       | `pnpm infra:up` / `pnpm infra:down` (data persists in named volumes) |
| Migrations            | `pnpm db:migrate`                                                    |
| Worker                | `pnpm worker:start`                                                  |
| CLI                   | `pnpm cli <start\|status\|approve\|reject\|migrate\|doctor>`         |
| Format / lint / types | `pnpm format` / `pnpm lint` / `pnpm typecheck`                       |
| Build / test          | `pnpm build` / `pnpm test`                                           |
| End-to-end smoke      | `pnpm smoke` (needs infra up + migrated)                             |
