import { z } from 'zod';
import {
  productTypeSchema,
  type BusinessEvaluation,
  type ResearchProposal,
} from '@platform/contracts';

/**
 * What the model is asked to return. Strict structured output needs every field present and nullable instead of
 * optional, so this differs slightly from the stored shapes; `toResearchProposal` and `toBusinessEvaluation` map it.
 * The JSON schemas below and these Zod schemas describe the same fields (a test compares their keys).
 */
const evidenceSchema = z
  .object({
    kind: z.enum(['assumption', 'test', 'source']),
    description: z.string(),
    url: z.string().nullable(),
  })
  .strict();

export const researchModelOutputSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    productType: productTypeSchema,
    domain: z.string(),
    market: z.string(),
    customer: z.string(),
    problem: z.string(),
    valueProposition: z.string(),
    demand: z
      .object({
        evidence: z.array(evidenceSchema),
        validationPlan: z.string(),
        willingnessToPay: z.string(),
      })
      .strict(),
    hosting: z
      .object({
        provider: z.string(),
        services: z.array(z.string()),
        productionGrade: z.boolean(),
        productionNotes: z.string(),
      })
      .strict(),
    delivery: z
      .object({
        weeksToLaunch: z.number(),
        deployableUnits: z.array(z.string()),
        complexityJustification: z.string().nullable(),
      })
      .strict(),
    cost: z
      .object({
        buildUsd: z.number(),
        monthlyRunUsd: z.number(),
        expectedMonthlyRevenueUsd: z.number().nullable(),
        breakEvenMonths: z.number().nullable(),
      })
      .strict(),
    assumptions: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .strict();
export type ResearchModelOutput = z.infer<typeof researchModelOutputSchema>;

export const evaluationModelOutputSchema = z
  .object({
    recommendation: z.enum(['proceed', 'do-not-proceed']),
    score: z.number(),
    rationale: z.string(),
  })
  .strict();

export interface Citation {
  url: string;
  title: string;
}

const MAX_CITATIONS = 10;

const validUrl = (value: string): string | undefined => {
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
};

/**
 * Citations come from the search tool's own annotations, so they are provenance the platform observed rather than
 * something the model claims. They are appended to the evidence the model wrote.
 */
export function toResearchProposal(
  model: ResearchModelOutput,
  citations: Citation[],
): ResearchProposal {
  const modelEvidence = model.demand.evidence.map(({ kind, description, url }) => {
    const parsed = url === null ? undefined : validUrl(url);
    return parsed ? { kind, description, url: parsed } : { kind, description };
  });
  const sourceEvidence = citations.slice(0, MAX_CITATIONS).map(({ url, title }) => ({
    kind: 'source' as const,
    description: title || url,
    url,
  }));
  return {
    fictionalExample: false,
    title: model.title,
    summary: model.summary,
    productType: model.productType,
    domain: model.domain,
    market: model.market,
    customer: model.customer,
    problem: model.problem,
    valueProposition: model.valueProposition,
    demand: {
      evidence: [...modelEvidence, ...sourceEvidence],
      validationPlan: model.demand.validationPlan,
      willingnessToPay: model.demand.willingnessToPay,
    },
    hosting: model.hosting,
    delivery: {
      weeksToLaunch: model.delivery.weeksToLaunch,
      deployableUnits: model.delivery.deployableUnits,
      ...(model.delivery.complexityJustification
        ? { complexityJustification: model.delivery.complexityJustification }
        : {}),
    },
    cost: {
      buildUsd: model.cost.buildUsd,
      monthlyRunUsd: model.cost.monthlyRunUsd,
      expectedMonthlyRevenueUsd: model.cost.expectedMonthlyRevenueUsd ?? 'unknown',
      breakEvenMonths: model.cost.breakEvenMonths ?? 'unknown',
    },
    assumptions: model.assumptions,
    unknowns: model.unknowns,
  };
}

/** `constraintChecks` stay empty: the platform computes them from the proposal and the limits. */
export function toBusinessEvaluation(
  model: z.infer<typeof evaluationModelOutputSchema>,
): BusinessEvaluation {
  return { ...model, isHumanApproval: false, constraintChecks: [] };
}

type JsonSchema = Record<string, unknown>;
const text: JsonSchema = { type: 'string' };
const number: JsonSchema = { type: 'number' };
const boolean: JsonSchema = { type: 'boolean' };
const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });
const list = (items: JsonSchema): JsonSchema => ({ type: 'array', items });
const enumOf = (values: readonly string[]): JsonSchema => ({ type: 'string', enum: values });
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const RESEARCH_JSON_SCHEMA = object({
  title: text,
  summary: text,
  productType: enumOf(productTypeSchema.options),
  domain: text,
  market: text,
  customer: text,
  problem: text,
  valueProposition: text,
  demand: object({
    evidence: list(
      object({
        kind: enumOf(['assumption', 'test', 'source']),
        description: text,
        url: nullable(text),
      }),
    ),
    validationPlan: text,
    willingnessToPay: text,
  }),
  hosting: object({
    provider: text,
    services: list(text),
    productionGrade: boolean,
    productionNotes: text,
  }),
  delivery: object({
    weeksToLaunch: number,
    deployableUnits: list(text),
    complexityJustification: nullable(text),
  }),
  cost: object({
    buildUsd: number,
    monthlyRunUsd: number,
    expectedMonthlyRevenueUsd: nullable(number),
    breakEvenMonths: nullable(number),
  }),
  assumptions: list(text),
  unknowns: list(text),
});

export const EVALUATION_JSON_SCHEMA = object({
  recommendation: enumOf(['proceed', 'do-not-proceed']),
  score: number,
  rationale: text,
});
