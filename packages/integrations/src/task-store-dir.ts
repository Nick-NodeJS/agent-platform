import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, derived from this package's location (`packages/integrations/{src,dist}` is three levels deep). */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Turns the configured `TASK_STORE_DIR` into one absolute path. Relative values are anchored at the repository root,
 * not at the process working directory, so the CLI and the worker always read and write the same files wherever
 * they are started from. Absolute values are used unchanged.
 */
export function resolveTaskStoreDir(configured: string): string {
  return resolveRepositoryPath(configured);
}

/** Absolute paths are used as given; relative ones are anchored at the repository root. */
export function resolveRepositoryPath(configured: string): string {
  return path.isAbsolute(configured) ? configured : path.resolve(REPOSITORY_ROOT, configured);
}
