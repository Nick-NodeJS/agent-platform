# ADR 0004: Linux kernel `flock` for the local file backend

**Status:** Accepted, implemented. Recorded retrospectively (it replaced a lock based on file modification times).

## Context

Several processes (worker, CLI, tests) may read and write the same task files. A lock that expires by timestamp lets a paused holder
lose the lock and later publish stale data; checking ownership just before a rename is not atomic with the rename.

## Decision

- Every task mutation holds an exclusive advisory **`flock(2)`** on a stable `.locks/<taskId>.lock` file through the `fs-ext` native binding,
  for the whole read-modify-write including both file publications. No lease, heartbeat, expiry or takeover. The lock file is never unlinked.
- Acquisition is non-blocking with bounded asynchronous backoff and a monotonic deadline; the kernel releases the lock when the holder dies.
- JSON is written by temp file and rename (readers take no lock); Markdown is derived and rebuildable. Scope: **Linux, local filesystems**;
  other platforms fail clearly instead of using a weaker lock.

## Consequences

- A paused writer blocks others until it resumes or dies (contenders time out) rather than being overtaken.
- `fs-ext` needs `build-essential` and `python3` at install time; the install script's `node-gyp` is pinned through pnpm settings.
- No NFS/SMB or multi-host support; a distributed task store would be a separate adapter ([ADR 2](0002-temporal-postgres-local-task-adapter.md)).
- The lock is advisory and there is no fsync; see [security](../architecture/security.md).

## Source pointers

[`file-lock.ts`](../../packages/integrations/src/file-lock.ts), [`local-task-store.ts`](../../packages/integrations/src/local-task-store.ts),
[`cross-process.test.ts`](../../packages/integrations/src/cross-process.test.ts), [`package.json`](../../package.json) (`pnpm` settings).
