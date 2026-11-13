import { describe, expect, it } from 'vitest';
import {
  approvalSchema,
  idSchema,
  loadConfig,
  modelProfileSchema,
  platformConstraintsSchema,
} from './index.js';

describe('idSchema', () => {
  it.each(['task-1', 'A_b-9'])('accepts %s', (id) =>
    expect(idSchema.safeParse(id).success).toBe(true),
  );
  it.each(['', '../x', 'a/b', '-lead', 'a b', 'x'.repeat(65)])('rejects %j', (id) =>
    expect(idSchema.safeParse(id).success).toBe(false),
  );
});

describe('modelProfileSchema', () => {
  const ok = { provider: 'p', model: 'm', maxSteps: 3, budget: { maxUsd: 1 } };
  it('accepts a valid profile with env var name', () =>
    expect(modelProfileSchema.safeParse({ ...ok, apiKeyEnvVar: 'MY_KEY' }).success).toBe(true));
  it('rejects a literal secret in place of an env var name', () =>
    expect(modelProfileSchema.safeParse({ ...ok, apiKeyEnvVar: 'sk-abcdef123456' }).success).toBe(
      false,
    ));
  it('rejects unknown fields (e.g. apiKey)', () =>
    expect(modelProfileSchema.safeParse({ ...ok, apiKey: 'x' }).success).toBe(false));
  it('rejects non-positive maxSteps', () =>
    expect(modelProfileSchema.safeParse({ ...ok, maxSteps: 0 }).success).toBe(false));
});

describe('platformConstraintsSchema', () => {
  it('records every unset limit as unknown and applies the simple-architecture defaults', () => {
    const parsed = platformConstraintsSchema.parse({});
    expect(parsed.limits).toEqual({
      buildBudgetUsd: 'unknown',
      monthlyRunCapUsd: 'unknown',
      launchDeadlineWeeks: 'unknown',
      minimumMonthlyMarginUsd: 'unknown',
      agentSpend: 'unknown',
    });
    expect(parsed.hosting).toEqual({
      preferredProvider: 'aws',
      allowedProviders: 'any',
      productionGradeRequired: true,
    });
    expect(parsed.architecture.forbiddenUnlessJustified).toEqual([
      'kubernetes',
      'microservices',
      'multi-region',
    ]);
    expect(parsed.excludedDomains).toBe('unknown');
  });

  it.each([
    ['a removed field (teamSize)', { teamSize: 3 }],
    ['a negative budget', { limits: { buildBudgetUsd: -1 } }],
    ['a zero deadline', { limits: { launchDeadlineWeeks: 0 } }],
    ['an unknown product type', { productTypes: { allowed: ['desktop'] } }],
    ['a sandbox-only hosting setting', { hosting: { productionGradeRequired: false } }],
    ['an invalid provider id', { hosting: { preferredProvider: 'AWS Cloud!' } }],
  ])('rejects %s', (_name, input) => {
    expect(platformConstraintsSchema.safeParse(input).success).toBe(false);
  });
});

describe('approvalSchema', () => {
  it('requires a source of human or agent', () =>
    expect(
      approvalSchema.safeParse({
        approvalId: 'a1',
        taskId: 't1',
        runId: 'r1',
        decision: 'approve',
        source: 'robot',
        actor: 'x',
        createdAt: new Date().toISOString(),
      }).success,
    ).toBe(false));
});

describe('loadConfig', () => {
  it('mock mode needs no API key', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db' });
    expect(cfg.EXECUTION_MODE).toBe('mock');
  });
  it('openhands mode requires its own settings', () =>
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db', EXECUTION_MODE: 'openhands' }),
    ).toThrow());
});
