import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Exclusive advisory lock on a stable file, using Linux `flock(2)` through the `fs-ext` native binding.
 *
 * Guarantees (Linux, local filesystems only):
 *  - The lock belongs to the open file description. Independent `open` calls contend even inside one process.
 *  - The kernel releases it when the descriptor closes, including when the process is killed. There is no lease,
 *    no timeout expiry and no takeover: a live but paused holder keeps the lock and contenders time out instead.
 *  - The lock file is never unlinked, renamed or replaced (that could split contenders across inodes).
 *
 * Not guaranteed: protection from a process that ignores the protocol (the lock is advisory), network
 * filesystems (NFS/SMB), or coordination between hosts.
 */

export class LockTimeoutError extends Error {}
export class UnsupportedPlatformError extends Error {}

export interface ExclusiveLockOptions {
  /** Maximum time to wait for a contended lock before failing with LockTimeoutError. */
  timeoutMs: number;
  /** Overridable so the unsupported-platform failure can be tested. */
  platform?: NodeJS.Platform;
}

const LOCK_FILE_MODE = 0o600;
const INITIAL_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 200;
/** Linux errno names that mean "someone else holds the lock" (EAGAIN == EWOULDBLOCK) or "interrupted, retry". */
const RETRYABLE_ERRNO_CODES = new Set(['EAGAIN', 'EWOULDBLOCK', 'EINTR']);

type FlockMode = 'exnb' | 'un';
type Flock = (fd: number, mode: FlockMode) => Promise<NodeJS.ErrnoException | null>;

let cachedFlock: Flock | undefined;

/** Loads the native binding lazily so merely importing this package never requires it (or a supported platform). */
async function loadFlock(platform: NodeJS.Platform): Promise<Flock> {
  if (platform !== 'linux') {
    throw new UnsupportedPlatformError(
      `The local task store requires Linux flock(2) on a local filesystem; platform "${platform}" is not supported.`,
    );
  }
  if (!cachedFlock) {
    const { flock } = await import('fs-ext');
    cachedFlock = (fd, mode) =>
      new Promise((resolve) => {
        flock(fd, mode, (error) => resolve(error));
      });
  }
  return cachedFlock;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const errnoCode = (error: NodeJS.ErrnoException): string => error.code ?? String(error.errno);

/** Monotonic clock: unaffected by wall-clock changes. */
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

async function acquire(flock: Flock, handle: FileHandle, timeoutMs: number): Promise<void> {
  const deadline = nowMs() + timeoutMs;
  let backoffMs = INITIAL_BACKOFF_MS;
  for (;;) {
    const failure = await flock(handle.fd, 'exnb');
    if (!failure) {
      return;
    }
    if (!RETRYABLE_ERRNO_CODES.has(errnoCode(failure))) {
      throw failure;
    }
    if (nowMs() + backoffMs > deadline) {
      throw new LockTimeoutError(`timed out after ${timeoutMs} ms waiting for the lock`);
    }
    await sleep(backoffMs + Math.random() * backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  }
}

/** Reports a cleanup failure without replacing the failure of the protected operation (if any). */
function reportCleanupFailure(step: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  process.emitWarning(`task lock ${step} failed: ${reason}`, { code: 'TASK_LOCK_CLEANUP_FAILED' });
}

/**
 * Runs `action` while holding the exclusive lock on `lockPath`. The descriptor stays open until the awaited action
 * settles; then it is unlocked and closed. Callers must not start work that outlives `action`.
 */
export async function withExclusiveLock<T>(
  lockPath: string,
  { timeoutMs, platform = process.platform }: ExclusiveLockOptions,
  action: () => Promise<T>,
): Promise<T> {
  const flock = await loadFlock(platform);
  await mkdir(path.dirname(lockPath), { recursive: true });
  // Non-truncating create. Node opens with O_CLOEXEC, so the descriptor is not inherited by child processes.
  const handle = await open(lockPath, constants.O_RDWR | constants.O_CREAT, LOCK_FILE_MODE);

  let outcome: { value: T } | { error: unknown };
  try {
    await acquire(flock, handle, timeoutMs);
    try {
      outcome = { value: await action() };
    } catch (error) {
      outcome = { error };
    }
    const unlockFailure = await flock(handle.fd, 'un');
    if (unlockFailure) {
      reportCleanupFailure('unlock', unlockFailure);
    }
  } finally {
    await handle.close().catch((error: unknown) => {
      reportCleanupFailure('close', error);
    });
  }

  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
