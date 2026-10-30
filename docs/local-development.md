# Local development

1. `nvm use` (Node 22.12.0), `corepack enable` or install pnpm 9.9.0.
2. `pnpm install --frozen-lockfile && cp .env.example .env && pnpm build`
3. `pnpm infra:up` starts Postgres 16.15 (loopback `5433`, so it does not clash with a local `5432`) and the Temporal dev server 1.9.1 (gRPC `7233`, UI `8233`, both loopback only). Temporal's SQLite store lives in the `temporal-data` volume and is development-only.
4. `pnpm db:migrate`, `pnpm doctor`, then `pnpm worker:start` in a separate terminal.
5. Run the workflow with the commands in the README. `pnpm smoke` automates start, pause, agent-signal rejection, worker restart, approve/reject, and consistency checks.

Mock mode needs no API keys. After code changes run `pnpm build` again (the worker runs compiled output).

Reset: `pnpm infra:down` keeps data; `docker compose --project-directory . -f infra/compose.yaml down -v` deletes the volumes (destructive).
Runtime output (`.task-data/`, logs, `.env`) is git-ignored.
