import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXECUTOR_CALL_LIMIT_MS } from './execution-limits.js';
import { modelProfilesSchema } from './model-profiles.js';
import { loadModelProfiles } from './node.js';

const committed = loadModelProfiles(
  fileURLToPath(new URL('../../../config/model-profiles.json', import.meta.url)),
);

describe('the committed model profiles', () => {
  it('use one priced model with the web search tool for the researcher only', () => {
    expect(committed.roles.researcher).toMatchObject({
      model: 'gpt-6.1-sol',
      tools: ['web_search'],
    });
    expect(committed.roles['business-owner']).toMatchObject({ tools: [], maxToolCalls: 0 });
    expect(committed.pricing['gpt-6.1-sol']).toMatchObject({
      inputPerMTokUsd: 2,
      outputPerMTokUsd: 10,
    });
    expect(committed.apiKeyEnvVar).toBe('OPENAI_API_KEY');
  });
});

describe('modelProfilesSchema', () => {
  const variant = (change: (draft: typeof committed) => void) => {
    const draft: typeof committed = structuredClone(committed);
    change(draft);
    return modelProfilesSchema.safeParse(draft);
  };

  it.each([
    [
      'an API key value instead of a variable name',
      (d: typeof committed) => (d.apiKeyEnvVar = 'sk-live-abc123'),
    ],
    ['a model without a price', (d: typeof committed) => (d.pricing = {})],
    [
      'a tool role without a tool-call ceiling',
      (d: typeof committed) => (d.roles.researcher.maxToolCalls = 0),
    ],
    [
      'tool calls for a role without tools',
      (d: typeof committed) => (d.roles['business-owner'].maxToolCalls = 3),
    ],
    [
      'a call time limit above the executor limit',
      (d: typeof committed) => (d.roles.researcher.timeoutMs = EXECUTOR_CALL_LIMIT_MS + 1),
    ],
    ['a negative reserve', (d: typeof committed) => (d.spend.minRemainingBudgetUsd = -1)],
  ])('rejects %s', (_name, change) => {
    expect(variant(change).success).toBe(false);
  });

  it('rejects unknown keys, so a typo cannot silently drop a ceiling', () => {
    expect(modelProfilesSchema.safeParse({ ...committed, maxBudget: 5 }).success).toBe(false);
  });
});
