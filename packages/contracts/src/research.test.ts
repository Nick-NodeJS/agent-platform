import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformConstraintsSchema, type PlatformConstraints } from './constraints.js';
import { loadPlatformConstraints } from './node.js';
import {
  businessEvaluationSchema,
  checkProposalAgainstConstraints,
  enforceConstraintChecks,
  researchProposalSchema,
  type BusinessEvaluation,
  type ResearchProposal,
} from './research.js';

const AGREED_FILE = fileURLToPath(
  new URL('../../../config/platform-constraints.json', import.meta.url),
);

/** A proposal that satisfies the owner-agreed limits; tests change one thing at a time. */
function proposal(overrides: Partial<ResearchProposal> = {}): ResearchProposal {
  return {
    fictionalExample: true,
    title: 'Example',
    summary: 'Example summary',
    productType: 'api',
    domain: 'logistics',
    market: 'small shops',
    customer: 'shop owners',
    problem: 'manual routing',
    valueProposition: 'saves time',
    demand: {
      evidence: [{ kind: 'test', description: 'ten interviews' }],
      validationPlan: 'waitlist page',
      willingnessToPay: 'monthly fee',
    },
    hosting: {
      provider: 'aws',
      services: ['managed-container-service', 'managed-database'],
      productionGrade: true,
      productionNotes: 'backups and monitoring',
    },
    delivery: { weeksToLaunch: 3, deployableUnits: ['api-service', 'managed-database'] },
    cost: { buildUsd: 30, monthlyRunUsd: 20, expectedMonthlyRevenueUsd: 100, breakEvenMonths: 1 },
    assumptions: [],
    unknowns: [],
    ...overrides,
  };
}

const agreed = (): PlatformConstraints => loadPlatformConstraints(AGREED_FILE);

const statusOf = (checks: ReturnType<typeof checkProposalAgainstConstraints>, rule: string) =>
  checks.find((check) => check.rule === rule)?.status;

describe('research proposal schema', () => {
  it('accepts a complete proposal and rejects missing or mistyped estimates', () => {
    expect(researchProposalSchema.safeParse(proposal()).success).toBe(true);
    expect(
      researchProposalSchema.safeParse({ ...proposal(), cost: { buildUsd: '30' } }).success,
    ).toBe(false);
    expect(researchProposalSchema.safeParse({ ...proposal(), demand: undefined }).success).toBe(
      false,
    );
  });
});

describe('checkProposalAgainstConstraints with the owner-agreed limits', () => {
  it('passes a proposal that fits every limit', () => {
    const checks = checkProposalAgainstConstraints(proposal(), agreed());
    expect(checks.filter((check) => check.status === 'fail')).toEqual([]);
    expect(statusOf(checks, 'build-budget')).toBe('pass');
    expect(statusOf(checks, 'minimum-monthly-margin')).toBe('not-applicable');
  });

  const breakages: [string, Partial<ResearchProposal>][] = [
    ['build-budget', { cost: { ...proposal().cost, buildUsd: 50.01 } }],
    ['monthly-run-cap', { cost: { ...proposal().cost, monthlyRunUsd: 51 } }],
    ['launch-deadline', { delivery: { ...proposal().delivery, weeksToLaunch: 5 } }],
    ['production-grade-hosting', { hosting: { ...proposal().hosting, productionGrade: false } }],
    [
      'simple-architecture',
      {
        delivery: {
          ...proposal().delivery,
          deployableUnits: ['api', 'worker', 'queue-service', 'database'],
        },
      },
    ],
    [
      'no-forbidden-technology',
      { hosting: { ...proposal().hosting, services: ['Kubernetes cluster', 'managed-database'] } },
    ],
    [
      'demand-evidence-present',
      { demand: { ...proposal().demand, evidence: [], validationPlan: '' } },
    ],
  ];

  it.each(breakages)('fails %s when the proposal breaks it', (rule, overrides) => {
    const checks = checkProposalAgainstConstraints(proposal(overrides), agreed());
    expect(statusOf(checks, rule)).toBe('fail');
  });

  it('accepts the limit values exactly at the boundary', () => {
    const edge = proposal({
      cost: { ...proposal().cost, buildUsd: 50, monthlyRunUsd: 50 },
      delivery: { ...proposal().delivery, weeksToLaunch: 4 },
    });
    expect(
      checkProposalAgainstConstraints(edge, agreed()).filter((check) => check.status === 'fail'),
    ).toEqual([]);
  });

  it('allows extra deployable units or a forbidden technology only with a justification', () => {
    const complex = proposal({
      hosting: { ...proposal().hosting, services: ['kubernetes'] },
      delivery: {
        ...proposal().delivery,
        deployableUnits: ['a', 'b', 'c'],
        complexityJustification: 'needs isolated tenants, measured at 5000 rps',
      },
    });
    const checks = checkProposalAgainstConstraints(complex, agreed());
    expect(statusOf(checks, 'simple-architecture')).toBe('pass');
    expect(statusOf(checks, 'no-forbidden-technology')).toBe('pass');
  });
});

describe('checkProposalAgainstConstraints with other limits', () => {
  it('restricts providers and product types when the owner lists them', () => {
    const strict = platformConstraintsSchema.parse({
      hosting: { allowedProviders: ['aws', 'vercel'] },
      productTypes: { allowed: ['api', 'web'] },
    });
    const checks = checkProposalAgainstConstraints(
      proposal({
        productType: 'mobile',
        hosting: { ...proposal().hosting, provider: 'heroku' },
      }),
      strict,
    );
    expect(statusOf(checks, 'hosting-provider-allowed')).toBe('fail');
    expect(statusOf(checks, 'product-type-allowed')).toBe('fail');
  });

  it('rejects excluded domains', () => {
    const constraints = platformConstraintsSchema.parse({ excludedDomains: ['gambling'] });
    expect(
      statusOf(
        checkProposalAgainstConstraints(proposal({ domain: 'Online Gambling' }), constraints),
        'domain-not-excluded',
      ),
    ).toBe('fail');
    expect(
      statusOf(checkProposalAgainstConstraints(proposal(), constraints), 'domain-not-excluded'),
    ).toBe('pass');
  });

  it('checks the minimum margin only when one is set, and requires a revenue estimate then', () => {
    const constraints = platformConstraintsSchema.parse({
      limits: { minimumMonthlyMarginUsd: 70 },
    });
    expect(
      statusOf(checkProposalAgainstConstraints(proposal(), constraints), 'minimum-monthly-margin'),
    ).toBe('pass');
    const lowRevenue = proposal({ cost: { ...proposal().cost, expectedMonthlyRevenueUsd: 80 } });
    expect(
      statusOf(checkProposalAgainstConstraints(lowRevenue, constraints), 'minimum-monthly-margin'),
    ).toBe('fail');
    const noEstimate = proposal({
      cost: { ...proposal().cost, expectedMonthlyRevenueUsd: 'unknown' },
    });
    expect(
      statusOf(checkProposalAgainstConstraints(noEstimate, constraints), 'minimum-monthly-margin'),
    ).toBe('fail');
  });

  it('reports unknown limits as not applicable instead of passing them silently', () => {
    const checks = checkProposalAgainstConstraints(proposal(), platformConstraintsSchema.parse({}));
    expect(statusOf(checks, 'build-budget')).toBe('not-applicable');
    expect(statusOf(checks, 'monthly-run-cap')).toBe('not-applicable');
    expect(statusOf(checks, 'launch-deadline')).toBe('not-applicable');
  });
});

describe('enforceConstraintChecks', () => {
  const evaluation = (overrides: Partial<BusinessEvaluation> = {}): BusinessEvaluation => ({
    recommendation: 'proceed',
    score: 8,
    rationale: 'Looks good.',
    isHumanApproval: false,
    constraintChecks: [{ rule: 'made-up', status: 'pass', detail: 'executor claim' }],
    ...overrides,
  });

  it('replaces executor-supplied checks with computed ones and keeps a valid recommendation', () => {
    const enforced = enforceConstraintChecks(evaluation(), proposal(), agreed());
    expect(enforced.recommendation).toBe('proceed');
    expect(enforced.constraintChecks.map((check) => check.rule)).not.toContain('made-up');
    expect(businessEvaluationSchema.safeParse(enforced).success).toBe(true);
  });

  it('downgrades a proceed recommendation when any rule fails and says why', () => {
    const over = proposal({ cost: { ...proposal().cost, buildUsd: 500 } });
    const enforced = enforceConstraintChecks(evaluation(), over, agreed());
    expect(enforced.recommendation).toBe('do-not-proceed');
    expect(enforced.rationale).toContain('Platform override: failed checks: build-budget');
  });

  it('never upgrades a do-not-proceed recommendation', () => {
    const enforced = enforceConstraintChecks(
      evaluation({ recommendation: 'do-not-proceed', rationale: 'Weak demand.' }),
      proposal(),
      agreed(),
    );
    expect(enforced.recommendation).toBe('do-not-proceed');
    expect(enforced.rationale).toBe('Weak demand.');
  });
});

describe('loadPlatformConstraints', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'constraints-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('the committed file holds the owner-agreed limits', () => {
    const constraints = agreed();
    expect(constraints.limits).toMatchObject({
      buildBudgetUsd: 50,
      monthlyRunCapUsd: 50,
      launchDeadlineWeeks: 4,
      agentSpend: 'unknown',
    });
    expect(constraints.productTypes.preferenceOrder).toEqual(['api', 'web', 'mobile']);
    expect(constraints.hosting.preferredProvider).toBe('aws');
  });

  it('lets command-line overrides win over the file and leaves other limits untouched', () => {
    const constraints = loadPlatformConstraints(AGREED_FILE, {
      buildBudgetUsd: 20,
      launchDeadlineWeeks: 2,
      notes: 'tighter run',
    });
    expect(constraints.limits).toMatchObject({
      buildBudgetUsd: 20,
      monthlyRunCapUsd: 50,
      launchDeadlineWeeks: 2,
    });
    expect(constraints.notes).toBe('tighter run');
  });

  it('rejects a file with unknown keys, invalid values or broken JSON', async () => {
    const write = async (name: string, content: string) => {
      const file = path.join(dir, name);
      await writeFile(file, content);
      return file;
    };
    const unknownKey = await write('a.json', '{"limits":{"teamSize":3}}');
    const negative = await write('b.json', '{"limits":{"buildBudgetUsd":-5}}');
    const broken = await write('c.json', '{not json');
    expect(() => loadPlatformConstraints(unknownKey)).toThrow();
    expect(() => loadPlatformConstraints(negative)).toThrow();
    expect(() => loadPlatformConstraints(broken)).toThrow();
    expect(() => loadPlatformConstraints(path.join(dir, 'missing.json'))).toThrow();
  });

  it('a minimal file means every limit is unknown, never a guessed default', async () => {
    const file = path.join(dir, 'minimal.json');
    await writeFile(file, '{}');
    expect(loadPlatformConstraints(file).limits.buildBudgetUsd).toBe('unknown');
  });
});
