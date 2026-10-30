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
- Approval waits on a signed decision submitted as the `submitDecision` Update (see "Review gate and approval trust boundary"). There is no unsigned Signal path.
- The mock business owner output has `isHumanApproval: false` and cannot advance the workflow.
- Activities (DB, files, agent calls) use stable IDs, fenced durable executions and idempotent mutations, so retries and restarts do not duplicate records or re-run agents unnecessarily. Retries are bounded (5 attempts, 1 minute timeout).
- No product repository is created.

## Data

PostgreSQL tables: `runs`, `results` (with content digest), `review_gates`, `approvals` (one decision per run, unique decision ID, signer key ID), `agent_executions`, `execution_events`, `cost_entries`. Temporal's dev server uses its own SQLite file in a separate volume; it is development-only.

## OpenHands: deferred setup task

Not implemented in milestone 1. `EXECUTION_MODE=openhands` fails explicitly (`RealExecutionNotImplementedError`); it never falls back to mock.

Verified from official docs (https://docs.openhands.dev/sdk/arch/agent-server, https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox):

- The Agent Server is a separate HTTP/WebSocket service (`python -m openhands.agent_server --host 127.0.0.1 --port 8000`), distinct from the OpenHands GUI. Health: `GET /health`, `GET /ready`; API under `/api/*`.
- Auth: `OH_SESSION_API_KEYS_0` on the server, `X-Session-API-Key` header on requests; set `OH_SECRET_KEY` for stable secrets. Do not expose it unauthenticated.
- The Docker sandbox uses image `ghcr.io/openhands/agent-server:<tag>-python` (docs show `latest-python`; a pinned tag/digest must be chosen) via `DockerWorkspace`, which needs access to a Docker daemon: a privileged sandbox-manager requirement that must be documented and isolated, not given to ordinary agents.

Not verified (so no Compose service is provided): a pinned image tag, the exact container launch command/volume layout for a standalone server container, and the HTTP request shapes for creating conversations. Setup task: choose a pinned image, validate these against the OpenAPI docs at `/docs`, then add an optional `openhands` Compose profile and implement `OpenHandsAgentExecutor` with per-role profiles and budget enforcement.

## Future

Jira implementation of `TaskStore`; real researcher/BO execution; additional roles (PM, architect, developer, QA, DevOps).

## Review gate and approval trust boundary

Flow: both agent results are saved (Postgres canonical, task projection) -> `openReviewGate` Activity persists the waiting
status and a `review_gates` row (stable gate ID, artifact IDs + SHA-256 content digests) -> only then does the workflow expose
the gate in its Query. Until then `submitDecision` Updates are rejected by the Update validator ("gate not open"); decisions
are never buffered, so a decision made before review can never pass the later gate.

Decision = Temporal Update `submitDecision` carrying a signed envelope. Rejected (Update fails, CLI exits non-zero, nothing
persisted): malformed payloads, wrong run/gate, different artifacts or digests, unknown/untrusted key, actor not matching the
trusted signer config, bad signature, expired/future/over-long validity (max 15 min), replayed decision ID, and artifacts that
changed in Postgres after the gate opened. The first valid decision wins; the workflow re-checks the gate after the async
verification Activity, so concurrent decisions cannot both be accepted. Workflow code is deterministic (structural checks only);
crypto, file and DB access happen in Activities. `recordDecision` re-verifies before persisting `source: human` approvals.

What this is: authorization by a trusted, human-controlled signer (Ed25519 private key held by the human CLI on the trusted host;
only the public key reaches the worker). Identity (`actor`) comes from the trusted-signers file, not from caller claims.
What this is not: proof that a biological person clicked a button, nor protection if an agent runs as the same OS user and can read
the private key or execute the CLI.

### Required isolation before real agent execution (plan; not implemented in the mock milestone)

- Agents run in containers/VMs as an unprivileged user with no host mounts except their task workspace; no Docker socket.
- Network: agent containers on an isolated network that can reach only the model provider/allowed tools. They cannot reach
  Temporal (7233), Postgres (5433) or the Temporal UI. Compose ports are loopback-only today; real execution must additionally use
  separate Docker networks/firewall rules.
- Approval keys live in a directory readable only by the approver's account (0700/0600), never mounted into agent or worker
  containers. The approver CLI is not installed in agent images and agents cannot execute host binaries.
- Prompts are not a boundary: these controls must be enforced by the OS/container/network before `EXECUTION_MODE` other than `mock` is enabled.
- Future/cloud: replace the local CLI signer with an authenticated approval API (SSO/WebAuthn-backed signing service) that
  issues the same signed envelopes; it is not required for local mock runs and no public HTTP service is added now.

## Agent execution durability

`agent_executions` has one row per (run, role, stage) with the input digest, state (`pending|running|succeeded|uncertain`), a
lease owner + monotonically increasing fence, `invoked_at`, and the actual `attempts`. An attempt claims the row with a fenced
DB lease (renewed by heartbeat), records `invoked_at` before calling the executor, then persists validated output, usage, the
canonical result and the cost entry in one transaction; stale attempts (old fence/owner) cannot write. The task projection and
cost entries are repaired from canonical data on retry. A succeeded execution is reused without calling the executor.

If the executor may have run but nothing was stored (crash, persistence failure, abandoned lease), the execution becomes
`uncertain` and the Activity fails non-retryably: it is never re-run automatically. `pnpm cli reconcile` is the explicit operator
step. Changing the input for an existing stage is refused (use a new stage/revision). The executor receives a stable
idempotency key (`runId:role:stage:inputDigest`); this prevents duplicate external work only if the provider/runtime implements
idempotency. PostgreSQL alone cannot give exactly-once billing for an external call: the design bounds the duplicate risk to
explicit operator decisions and records real attempt counts. Mock executions cost 0.

## LocalTaskStore concurrency

Every task mutation (`createTask`, `attachResult`, `recordApproval`, `changeStatus`, `rebuildProjection`) is one read-modify-write
under an exclusive advisory **Linux `flock(2)`** (`packages/integrations/src/file-lock.ts`, `fs-ext` native binding) on a stable
file `<real root>/.locks/<taskId>.lock`. The descriptor stays open until both the JSON and Markdown publications finish, then the
lock is released and the descriptor closed. Contenders poll with `exnb` and bounded backoff against a monotonic deadline
(`lockTimeoutMs`, default 15 s) and fail with `LockTimeoutError`.

- **No leases.** There is no stale timeout, mtime heartbeat or takeover. A live but paused writer keeps the lock and contenders
  time out; the kernel releases the lock when the holder dies (even by SIGKILL), so recovery needs no waiting period.
- The lock file is never unlinked, renamed or replaced (that could split contenders across inodes); small `.locks` files persist.
- Independent opens contend even inside one process; descriptors are not inherited by child processes.
- Publication: each file is written to a temporary name and renamed, so lock-free readers see a complete old or new JSON.
  JSON is canonical; Markdown is published second and rebuilt from JSON by any later operation or `rebuildProjection`. The two
  renames are not one atomic transaction and nothing is fsynced: power-loss durability is not promised.
- **Supported:** Linux on local filesystems (Ubuntu host or Linux container). **Not supported:** macOS/Windows (the store throws
  `UnsupportedPlatformError`, never a weaker fallback), NFS/SMB or network-synced folders, multi-host/cloud coordination (that would be a
  separate task-store integration). The lock is advisory: every legitimate writer must use the store; an arbitrary editor can bypass it.
- Build prerequisite: `fs-ext` is compiled by node-gyp (`build-essential`, `python3`); `package.json` pins `node-gyp` for its
  install script via `pnpm.packageExtensions` and lists `fs-ext` in `pnpm.onlyBuiltDependencies`.

Status order is `CREATED < RESEARCHING < EVALUATING < WAITING_FOR_HUMAN_APPROVAL < APPROVED = REJECTED`: statuses only move forward
and the first terminal status wins.

## Workflow versioning

The approval mechanism changed from an unsigned Signal to a signed Update and the workflow gained a gate step. Workflows started
by the previous code are not replay-compatible. This is a local mock-only project: do not resume old runs; start new runs (new run IDs).
Old histories were not deleted. Production-style evolution would use `patched()`/Worker Versioning.
