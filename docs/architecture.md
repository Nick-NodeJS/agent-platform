# Architecture

## Layout

- `packages/contracts` - Zod schemas, `TaskStore` / `AgentExecutor` interfaces, config loading, workflow types.
- `packages/agents` - role definitions and model profiles (placeholders only) plus `assertProfileConfigured`.
- `packages/integrations` - `LocalTaskStore` (atomic JSON + Markdown), `MockAgentExecutor`, OpenHands boundary stub, secret redaction.
- `packages/persistence` - PostgreSQL migrations and `RunRepository` (idempotent writes).
- `apps/worker` - Temporal worker, `researchProposalWorkflow`, Activities.
- `apps/cli` - `start`, `status`, `approve`, `reject`, `migrate`, `doctor`.

## Workflow (`researchProposalWorkflow`)

`CREATED -> RESEARCHING -> EVALUATING -> WAITING_FOR_HUMAN_APPROVAL -> APPROVED | REJECTED`

- Workflow ID = client-generated run ID. Query `getStatus` exposes status/stages/results.
- Approval waits on the `decision` Signal via `condition()`. Only `source: 'human'` signals count; first decision wins; later ones are ignored. The CLI always sets `source: 'human'`.
- The mock business owner output has `isHumanApproval: false` and cannot advance the workflow.
- Activities (DB, files, agent calls) use stable IDs and `ON CONFLICT DO NOTHING` / idempotent file mutations, so retries and restarts do not duplicate records. Retries are bounded (5 attempts, 1 minute timeout).
- No product repository is created.

## Data

PostgreSQL tables: `runs`, `results`, `approvals` (one decision per run), `execution_events`, `cost_entries`. Temporal's dev server uses its own SQLite file in a separate volume; it is development-only.

## OpenHands: deferred setup task

Not implemented in milestone 1. `EXECUTION_MODE=openhands` fails explicitly (`RealExecutionNotImplementedError`); it never falls back to mock.

Verified from official docs (https://docs.openhands.dev/sdk/arch/agent-server, https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox):

- The Agent Server is a separate HTTP/WebSocket service (`python -m openhands.agent_server --host 127.0.0.1 --port 8000`), distinct from the OpenHands GUI. Health: `GET /health`, `GET /ready`; API under `/api/*`.
- Auth: `OH_SESSION_API_KEYS_0` on the server, `X-Session-API-Key` header on requests; set `OH_SECRET_KEY` for stable secrets. Do not expose it unauthenticated.
- The Docker sandbox uses image `ghcr.io/openhands/agent-server:<tag>-python` (docs show `latest-python`; a pinned tag/digest must be chosen) via `DockerWorkspace`, which needs access to a Docker daemon: a privileged sandbox-manager requirement that must be documented and isolated, not given to ordinary agents.

Not verified (so no Compose service is provided): a pinned image tag, the exact container launch command/volume layout for a standalone server container, and the HTTP request shapes for creating conversations. Setup task: choose a pinned image, validate these against the OpenAPI docs at `/docs`, then add an optional `openhands` Compose profile and implement `OpenHandsAgentExecutor` with per-role profiles and budget enforcement.

## Future

Jira implementation of `TaskStore`; real researcher/BO execution; additional roles (PM, architect, developer, QA, DevOps).
