import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockTimeoutError, UnsupportedPlatformError, withExclusiveLock } from './file-lock.js';

describe('withExclusiveLock', () => {
  let dir: string;
  let lockPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'file-lock-'));
    lockPath = path.join(dir, '.locks', 'a.lock');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('serializes independent acquisitions in one process and passes the action result through', async () => {
    const order: string[] = [];
    let slowHoldsLock = () => {};
    const slowIsInside = new Promise<void>((resolve) => {
      slowHoldsLock = resolve;
    });
    const slow = withExclusiveLock(lockPath, { timeoutMs: 2000 }, async () => {
      order.push('slow-start');
      slowHoldsLock();
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push('slow-end');
      return 'slow';
    });
    await slowIsInside; // readiness barrier: the second contender starts only once the first holds the lock
    const quick = withExclusiveLock(lockPath, { timeoutMs: 2000 }, async () => {
      order.push('quick');
      return 'quick';
    });
    expect(await Promise.all([slow, quick])).toEqual(['slow', 'quick']);
    expect(order).toEqual(['slow-start', 'slow-end', 'quick']);
  });

  it('times out with LockTimeoutError instead of waiting forever, and the holder is unaffected', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired = () => {};
    const holderLocked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const holder = withExclusiveLock(lockPath, { timeoutMs: 1000 }, async () => {
      acquired();
      await gate;
      return 'held';
    });
    await holderLocked;
    await expect(
      withExclusiveLock(lockPath, { timeoutMs: 100 }, async () => 'never'),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    release();
    expect(await holder).toBe('held');
  });

  it('rethrows the action failure and still releases the lock', async () => {
    await expect(
      withExclusiveLock(lockPath, { timeoutMs: 1000 }, async () => {
        throw new Error('action failed');
      }),
    ).rejects.toThrow('action failed');
    expect(await withExclusiveLock(lockPath, { timeoutMs: 200 }, async () => 'next')).toBe('next');
  });

  it('keeps the lock file after release (it is never unlinked)', async () => {
    await withExclusiveLock(lockPath, { timeoutMs: 1000 }, async () => undefined);
    expect((await stat(lockPath)).isFile()).toBe(true);
  });

  it.each(['darwin', 'win32'] as const)(
    'fails clearly on unsupported platform %s without creating a lock',
    async (platform) => {
      await expect(
        withExclusiveLock(lockPath, { timeoutMs: 100, platform }, async () => 'unreachable'),
      ).rejects.toBeInstanceOf(UnsupportedPlatformError);
      await expect(stat(lockPath)).rejects.toThrow();
    },
  );
});
