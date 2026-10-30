# ADR 0001: TypeScript monorepo; separate platform and product repositories

**Status:** Accepted, implemented. Recorded retrospectively.

## Context

The platform is a reusable orchestration engine plus shared packages. Products it may later build are different projects with their
own lifecycle, and a product should exist only after research, business-owner evaluation and the owner's explicit approval
([project state](../project-state.md), agreed decisions).

## Decision

- All custom application code is **TypeScript** (strict mode, Node ESM) in one **pnpm workspace** (`apps/*`, `packages/*`) without a build
  orchestrator such as Nx or Turborepo. Workspace packages are consumed through their compiled `dist/` output and types.
- The **platform repository** holds the engine; each **product** gets its own repository, created only after explicit human approval
  (and a demand/acquisition feasibility check). No product repository exists.
- Python may appear only as a separate service (for example a future OpenHands server) or as a native build tool (`node-gyp`); no custom Python or Rust.

## Consequences

- One toolchain, shared contracts, one CI. Because packages export from `dist/`, lint and typecheck need a prior build (`pnpm verify`).
- Product code never lives in this repository; the platform stays reusable.
- A native dependency (`fs-ext`) means `build-essential` and `python3` are installation prerequisites ([ADR 4](0004-linux-flock-local-file-backend.md)).

## Source pointers

[`package.json`](../../package.json), [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), [`tsconfig.base.json`](../../tsconfig.base.json),
[`docs/code-quality.md`](../code-quality.md), [`ci.yml`](../../.github/workflows/ci.yml).
