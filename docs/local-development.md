# Local development

1. Linux only. Install the native build prerequisites once (`fs-ext` is compiled by node-gyp; Python is a build tool only):
   `sudo apt-get install -y build-essential python3`. Then `nvm use` (Node 22.12.0) and `corepack enable` or install pnpm 9.9.0.
2. `pnpm install --frozen-lockfile && cp .env.example .env && pnpm verify`. Workspace packages export their types from `dist/`,
   so `pnpm verify` runs format check, **build**, lint, typecheck in that order; lint on a clean checkout fails if the build is skipped.
   If `fs-ext` fails to build, `pnpm install` fails; scripts are never skipped.
3. `pnpm infra:up` starts Postgres 16.15 (loopback `5433`, so it does not clash with a local `5432`) and the Temporal dev server 1.9.1 (gRPC `7233`, UI `8233`, both loopback only). Temporal's SQLite store lives in the `temporal-data` volume and is development-only.
4. `pnpm db:migrate`, then once `pnpm cli approval-keygen --actor <name>` and add the printed `APPROVAL_TRUSTED_SIGNERS_FILE=...` (public keys only) to `.env`. Then `pnpm doctor` and `pnpm worker:start` in a separate terminal.
5. Run the workflow with the commands in the README. `pnpm smoke` automates start, pause, forged-decision rejection, worker restart, signed approve/reject (using a temporary key outside the repo), and consistency checks. `pnpm test:integration` runs the live Temporal/Postgres suites in a temporary database that it drops afterwards.

Mock mode needs no API keys. After code changes run `pnpm build` again (the worker runs compiled output).

Reset: `pnpm infra:down` keeps data; `docker compose --project-directory . -f infra/compose.yaml down -v` deletes the volumes (destructive).
Runtime output (`.task-data/`, logs, `.env`) is git-ignored.

After pulling changes with new migrations run `pnpm db:migrate` (additive; existing data is kept). Runs started before the signed-approval change are not replay-compatible: start new runs.

## Real agents (optional, spends money)

1. Set `EXECUTION_MODE=openai` and `OPENAI_API_KEY=...` in the worker's environment (`.env` is git-ignored). Models, ceilings and prices are in `config/model-profiles.json`;
   limits and the agent allowance (`limits.agentSpend`, 3 USD per run and 20 USD per month) are in `config/platform-constraints.json`.
2. In the OpenAI dashboard set a project spend limit as the outer boundary: the platform's guard stops new calls but cannot stop one call mid-way.
3. `pnpm build && pnpm openai:check --confirm-spend` makes one researcher and one business-owner call (searches capped at 3) and prints cost, tokens and the limit checks. It writes nothing
   to the database. It is the only check that touches the live API; CI never calls it.
4. `pnpm doctor` reports the mode, whether the profiles file is valid and whether the key variable is set (name only). Then `pnpm worker:start` and the usual `pnpm cli start ...`;
   `pnpm cli executions <run>` shows the cost of each call.
