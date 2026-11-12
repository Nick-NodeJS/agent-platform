import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveTaskStoreDir } from './task-store-dir.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('resolveTaskStoreDir', () => {
  afterEach(() => vi.restoreAllMocks());

  it('anchors the default relative directory at the repository root, whatever the working directory is', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/somewhere/else');

    expect(resolveTaskStoreDir('.task-data/tasks')).toBe(
      path.join(REPOSITORY_ROOT, '.task-data', 'tasks'),
    );
  });

  it('uses an absolute directory unchanged', () => {
    expect(resolveTaskStoreDir('/var/tmp/agent-tasks')).toBe('/var/tmp/agent-tasks');
  });

  it('points at the directory that contains the workspace file', async () => {
    const { access } = await import('node:fs/promises');
    await expect(
      access(path.join(REPOSITORY_ROOT, 'pnpm-workspace.yaml')),
    ).resolves.toBeUndefined();
  });
});
