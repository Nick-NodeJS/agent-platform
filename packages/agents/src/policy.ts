import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '@platform/contracts/node';

/** Repository policy documents every platform-spawned coding or review agent must be given as context. */
export const POLICY_FILES = ['AGENTS.md', 'docs/code-quality.md'] as const;

export interface PolicyContext {
  /** Concatenated policy text to place at the start of the agent's context. */
  text: string;
  /** Digest of the exact text, so a run record can show which policy version the agent received. */
  digest: string;
  sources: readonly string[];
}

/**
 * Explicit context loading for future coding/review agents. `AGENTS.md` is not discovered automatically by every
 * agent framework, so the executor that starts such an agent must call this and pass the result as context.
 * Loading the text is not enforcement: mechanical rules live in ESLint, TypeScript, Vitest and CI, and access
 * restrictions are enforced outside the model.
 */
export async function loadPolicyContext(repoRoot: string): Promise<PolicyContext> {
  const sections = await Promise.all(
    POLICY_FILES.map(async (file) => {
      const content = await readFile(path.join(repoRoot, file), 'utf8');
      return `<!-- ${file} -->\n${content.trim()}`;
    }),
  );
  const text = sections.join('\n\n');
  return { text, digest: sha256Hex(text), sources: POLICY_FILES };
}
