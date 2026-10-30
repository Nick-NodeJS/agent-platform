# ADR 0005: Local sequential direct-API research first; OpenHands deferred to coding

**Status:** **Accepted direction; implementation pending.** Nothing in this ADR is implemented. The current agents are mocks.

## Context

The first valuable flow is research → business-owner evaluation → human approval. It needs model and search calls but no code, files or
terminal tools. OpenHands provides isolated workspaces and coding tools, which research does not need ([project state](../project-state.md)).

## Decision

- Run locally on the owner's Ubuntu machine, **sequentially**, with Temporal as the only coordinator. Roles are executed when needed;
  they are not always-running services.
- The researcher and business owner will call model and search providers **directly** through the narrow typed `AgentExecutor` contract
  (`AgentRoleIO`), with per-role configuration, real usage metering on top of the existing execution and cost records (mock records exist today; metering and spending limits do not), and budgets and permissions enforced outside the model.
- **OpenHands is deferred** until development tasks need code, file or terminal tools and isolated workspaces (roadmap step 8). It is not a prerequisite for research.
- No LangGraph, Mastra, CrewAI or second coordinator. Parallel execution, Jira and cloud hosting come only after the local sequential flow is validated.
- No product repository before research, evaluation and the owner's explicit approval, with a demand/acquisition feasibility check first.

## Consequences

- The executor, timeouts (the workflow uses a 1-minute Activity timeout), output validation and budget enforcement must be designed in roadmap step 3.
- `OpenHandsAgentExecutor` stays a stub that fails as "not started"; `EXECUTION_MODE=openhands` is not usable.
- The owner's budgets, markets and acquisition assumptions are not decided here.

## Notes for the later OpenHands step (verified against official docs at bootstrap; re-verify before use)

The OpenHands Agent Server is a separate HTTP/WebSocket service (not the GUI) with `GET /health`, `GET /ready` and authenticated `/api/*`
(`X-Session-API-Key`); its Docker sandbox needs access to a Docker daemon, a privileged requirement that must be isolated from ordinary agents.
A pinned image tag, container launch layout and conversation API shapes were **not** verified, so no Compose service exists.
Docs: https://docs.openhands.dev/sdk/arch/agent-server, https://docs.openhands.dev/sdk/guides/agent-server/docker-sandbox.

## Source pointers

[`interfaces.ts`](../../packages/contracts/src/interfaces.ts) (`AgentExecutor`, `AgentRoleIO`), [`executors.ts`](../../packages/integrations/src/executors.ts),
[`packages/agents`](../../packages/agents/src/index.ts), [`config.ts`](../../packages/contracts/src/config.ts), [roadmap](../project-state.md).
