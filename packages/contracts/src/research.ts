import { z } from 'zod';
import {
  orUnknown,
  productTypeSchema,
  providerIdSchema,
  type PlatformConstraints,
} from './constraints.js';

const nonNegativeNumber = z.number().nonnegative();

/** One piece of support for the claim that customers need the product and will pay for it. */
const demandEvidenceSchema = z
  .object({
    kind: z.enum(['assumption', 'test', 'source']),
    description: z.string().min(1),
    url: z.string().url().optional(),
  })
  .strict();

/**
 * Structured research output. Estimates are explicit numbers so the platform can check them against the limits.
 * `fictionalExample` is true for mock output and false for real agent output.
 */
export const researchProposalSchema = z
  .object({
    fictionalExample: z.boolean(),
    title: z.string().min(1),
    summary: z.string().min(1),
    productType: productTypeSchema,
    domain: z.string().min(1),
    market: z.string().min(1),
    customer: z.string().min(1),
    problem: z.string().min(1),
    valueProposition: z.string().min(1),
    demand: z
      .object({
        evidence: z.array(demandEvidenceSchema),
        validationPlan: z.string(),
        willingnessToPay: z.string().min(1),
      })
      .strict(),
    hosting: z
      .object({
        provider: providerIdSchema,
        services: z.array(z.string().min(1)).min(1),
        productionGrade: z.boolean(),
        productionNotes: z.string().min(1),
      })
      .strict(),
    delivery: z
      .object({
        weeksToLaunch: z.number().positive(),
        /** Independently deployed parts (for example `api-service`, `managed-database`). */
        deployableUnits: z.array(z.string().min(1)).min(1),
        complexityJustification: z.string().optional(),
      })
      .strict(),
    cost: z
      .object({
        buildUsd: nonNegativeNumber,
        monthlyRunUsd: nonNegativeNumber,
        expectedMonthlyRevenueUsd: orUnknown(nonNegativeNumber),
        breakEvenMonths: orUnknown(nonNegativeNumber),
      })
      .strict(),
    assumptions: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .strict();
export type ResearchProposal = z.infer<typeof researchProposalSchema>;

export const constraintCheckSchema = z
  .object({
    rule: z.string().min(1),
    status: z.enum(['pass', 'fail', 'not-applicable']),
    detail: z.string(),
  })
  .strict();
export type ConstraintCheck = z.infer<typeof constraintCheckSchema>;

/**
 * The business owner's recommendation. It is an agent decision, never a human approval. `constraintChecks` are
 * always computed by the platform from the proposal and the limits; anything an executor supplies is replaced.
 */
export const businessEvaluationSchema = z
  .object({
    recommendation: z.enum(['proceed', 'do-not-proceed']),
    score: z.number().min(0).max(10),
    rationale: z.string(),
    isHumanApproval: z.literal(false),
    constraintChecks: z.array(constraintCheckSchema),
  })
  .strict();
export type BusinessEvaluation = z.infer<typeof businessEvaluationSchema>;

const pass = (rule: string, detail: string): ConstraintCheck => ({ rule, status: 'pass', detail });
const fail = (rule: string, detail: string): ConstraintCheck => ({ rule, status: 'fail', detail });
const notApplicable = (rule: string, detail: string): ConstraintCheck => ({
  rule,
  status: 'not-applicable',
  detail,
});

/** `value <= limit` where an unknown limit cannot be checked (and is reported as such, not as a pass). */
function atMost(rule: string, label: string, value: number, limit: number | 'unknown') {
  if (limit === 'unknown') {
    return notApplicable(rule, `no ${label} limit is set`);
  }
  return value <= limit
    ? pass(rule, `${value} is within the ${label} limit of ${limit}`)
    : fail(rule, `${value} exceeds the ${label} limit of ${limit}`);
}

const mentionsAny = (texts: string[], terms: string[]): string[] =>
  terms.filter((term) => texts.some((text) => text.toLowerCase().includes(term.toLowerCase())));

/**
 * Deterministic, I/O-free rules a proposal must satisfy. This is the platform's enforcement of the technical and
 * financial limits; it does not judge demand quality (that is the business owner's analysis).
 */
export function checkProposalAgainstConstraints(
  proposal: ResearchProposal,
  constraints: PlatformConstraints,
): ConstraintCheck[] {
  const { limits, hosting, architecture, productTypes, excludedDomains } = constraints;
  const justified = Boolean(proposal.delivery.complexityJustification?.trim());
  const checks: ConstraintCheck[] = [
    atMost('build-budget', 'build budget (USD)', proposal.cost.buildUsd, limits.buildBudgetUsd),
    atMost(
      'monthly-run-cap',
      'monthly run cap (USD)',
      proposal.cost.monthlyRunUsd,
      limits.monthlyRunCapUsd,
    ),
    atMost(
      'launch-deadline',
      'launch deadline (weeks)',
      proposal.delivery.weeksToLaunch,
      limits.launchDeadlineWeeks,
    ),
    productTypes.allowed.includes(proposal.productType)
      ? pass('product-type-allowed', `${proposal.productType} is an allowed product type`)
      : fail('product-type-allowed', `${proposal.productType} is not an allowed product type`),
  ];

  const providerAllowed =
    hosting.allowedProviders === 'any' ||
    hosting.allowedProviders.includes(proposal.hosting.provider);
  checks.push(
    providerAllowed
      ? pass('hosting-provider-allowed', `${proposal.hosting.provider} is allowed`)
      : fail('hosting-provider-allowed', `${proposal.hosting.provider} is not an allowed provider`),
    proposal.hosting.productionGrade
      ? pass('production-grade-hosting', 'the proposal describes a production-grade setup')
      : fail('production-grade-hosting', 'the proposal describes a sandbox or demo setup'),
  );

  const units = proposal.delivery.deployableUnits.length;
  checks.push(
    units <= architecture.maxDeployableUnitsWithoutJustification || justified
      ? pass(
          'simple-architecture',
          `${units} deployable unit(s)${justified ? ', complexity justified' : ''}`,
        )
      : fail(
          'simple-architecture',
          `${units} deployable units exceed ${architecture.maxDeployableUnitsWithoutJustification} without a justification`,
        ),
  );

  const forbiddenUsed = mentionsAny(
    [...proposal.hosting.services, ...proposal.delivery.deployableUnits],
    architecture.forbiddenUnlessJustified,
  );
  checks.push(
    forbiddenUsed.length === 0 || justified
      ? pass(
          'no-forbidden-technology',
          forbiddenUsed.length === 0 ? 'none used' : 'used with a justification',
        )
      : fail('no-forbidden-technology', `uses ${forbiddenUsed.join(', ')} without a justification`),
  );

  checks.push(
    excludedDomains === 'unknown'
      ? notApplicable('domain-not-excluded', 'no excluded domains are set')
      : mentionsAny([proposal.domain], excludedDomains).length === 0
        ? pass('domain-not-excluded', `${proposal.domain} is not excluded`)
        : fail('domain-not-excluded', `${proposal.domain} is an excluded domain`),
  );

  checks.push(profitCheck(proposal, limits.minimumMonthlyMarginUsd));

  const hasEvidence =
    proposal.demand.evidence.length > 0 && proposal.demand.validationPlan.trim() !== '';
  checks.push(
    hasEvidence
      ? pass('demand-evidence-present', 'demand evidence and a validation plan are given')
      : fail('demand-evidence-present', 'demand evidence and a validation plan are required'),
  );
  return checks;
}

function profitCheck(
  proposal: ResearchProposal,
  requiredMargin: number | 'unknown',
): ConstraintCheck {
  const rule = 'minimum-monthly-margin';
  if (requiredMargin === 'unknown') {
    return notApplicable(rule, 'no minimum margin is set');
  }
  const { expectedMonthlyRevenueUsd, monthlyRunUsd } = proposal.cost;
  if (expectedMonthlyRevenueUsd === 'unknown') {
    return fail(rule, 'a revenue estimate is required to check the margin');
  }
  const margin = expectedMonthlyRevenueUsd - monthlyRunUsd;
  return margin >= requiredMargin
    ? pass(rule, `expected margin ${margin} meets the minimum of ${requiredMargin}`)
    : fail(rule, `expected margin ${margin} is below the minimum of ${requiredMargin}`);
}

/**
 * Replaces the executor's `constraintChecks` with platform-computed ones and downgrades a `proceed` to
 * `do-not-proceed` when any rule failed. The returned value is what gets stored.
 */
export function enforceConstraintChecks(
  evaluation: BusinessEvaluation,
  proposal: ResearchProposal,
  constraints: PlatformConstraints,
): BusinessEvaluation {
  const constraintChecks = checkProposalAgainstConstraints(proposal, constraints);
  const failed = constraintChecks.filter((check) => check.status === 'fail');
  if (failed.length === 0 || evaluation.recommendation === 'do-not-proceed') {
    return { ...evaluation, constraintChecks };
  }
  return {
    ...evaluation,
    recommendation: 'do-not-proceed',
    rationale: `${evaluation.rationale} Platform override: failed checks: ${failed.map((check) => check.rule).join(', ')}.`,
    constraintChecks,
  };
}
