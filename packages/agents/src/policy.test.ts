import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicyContext, POLICY_FILES } from './policy.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('loadPolicyContext', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'policy-'));
    await mkdir(path.join(dir, 'docs'));
    await writeFile(path.join(dir, 'AGENTS.md'), '# agents rules\n');
    await writeFile(path.join(dir, 'docs', 'code-quality.md'), '# quality rules\n');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('returns every policy document in order, labelled by source', async () => {
    const policy = await loadPolicyContext(dir);
    expect(policy.sources).toEqual(POLICY_FILES);
    expect(policy.text.indexOf('# agents rules')).toBeLessThan(
      policy.text.indexOf('# quality rules'),
    );
    expect(policy.text).toContain('<!-- docs/code-quality.md -->');
  });

  it('the digest changes when the policy text changes', async () => {
    const before = await loadPolicyContext(dir);
    await writeFile(path.join(dir, 'docs', 'code-quality.md'), '# quality rules, revised\n');
    const after = await loadPolicyContext(dir);
    expect(after.digest).not.toBe(before.digest);
    expect(after.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails loudly when a policy document is missing instead of starting an agent without it', async () => {
    await rm(path.join(dir, 'AGENTS.md'));
    await expect(loadPolicyContext(dir)).rejects.toThrow(/AGENTS\.md/);
  });

  it('this repository ships every document the loader requires', async () => {
    const policy = await loadPolicyContext(REPO_ROOT);
    expect(policy.text).toContain('Code quality policy');
  });
});
