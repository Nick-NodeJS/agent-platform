import { z } from 'zod';

/** Real-world values are never guessed: anything not supplied is the literal 'unknown'. */
export const orUnknown = <T extends z.ZodTypeAny>(schema: T) =>
  z
    .union([schema, z.literal('unknown')])
    .optional()
    .transform((value) => value ?? ('unknown' as const));

export const productTypeSchema = z.enum(['api', 'web', 'mobile']);
export type ProductType = z.infer<typeof productTypeSchema>;

/** Provider ids are lowercase kebab-case names such as `aws`, `vercel` or `expo-eas`. */
export const providerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

const FORBIDDEN_UNLESS_JUSTIFIED = ['kubernetes', 'microservices', 'multi-region'];
const MAX_DEPLOYABLE_UNITS_WITHOUT_JUSTIFICATION = 2;

const agentSpendSchema = z.union([
  z
    .object({ unit: z.enum(['usd', 'weekly-allowance']), amount: z.number().nonnegative() })
    .strict(),
  z.literal('unknown'),
]);

const limitsSchema = z
  .object({
    /** Total spend to build and launch the product (infrastructure, domains, tools). Not the agents' own compute. */
    buildBudgetUsd: orUnknown(z.number().nonnegative()),
    /** Cap on the product's recurring monthly running cost. */
    monthlyRunCapUsd: orUnknown(z.number().nonnegative()),
    /** Latest acceptable launch, in weeks from approval. */
    launchDeadlineWeeks: orUnknown(z.number().positive()),
    /** Required monthly revenue minus running cost; 0 means break-even. */
    minimumMonthlyMarginUsd: orUnknown(z.number()),
    /** The agents' own compute allowance (a USD cap or a weekly allowance); separate from the product budget. */
    agentSpend: agentSpendSchema.optional().transform((value) => value ?? ('unknown' as const)),
  })
  .strict();

const hostingSchema = z
  .object({
    preferredProvider: providerIdSchema.default('aws'),
    /** `any` allows every provider; otherwise only the listed ones. */
    allowedProviders: z.union([z.literal('any'), z.array(providerIdSchema).min(1)]).default('any'),
    /** The product must run as a real, maintained service (environments, backups, monitoring), not a sandbox. */
    productionGradeRequired: z.literal(true).default(true),
  })
  .strict();

const architectureSchema = z
  .object({
    preferSingleDeployable: z.boolean().default(true),
    /** More deployable units than this need an explicit complexity justification in the proposal. */
    maxDeployableUnitsWithoutJustification: z
      .number()
      .int()
      .positive()
      .default(MAX_DEPLOYABLE_UNITS_WITHOUT_JUSTIFICATION),
    /** Technologies a proposal may not use unless it justifies the complexity. */
    forbiddenUnlessJustified: z.array(z.string().min(1)).default(FORBIDDEN_UNLESS_JUSTIFIED),
  })
  .strict();

const productTypesSchema = z
  .object({
    allowed: z.array(productTypeSchema).min(1).default(['api', 'web', 'mobile']),
    /** Most preferred first. */
    preferenceOrder: z.array(productTypeSchema).min(1).default(['api', 'web', 'mobile']),
  })
  .strict();

/**
 * Limits and technical rules that every research and evaluation call must respect.
 * Validated here, shown to agents as structured input, and re-checked by the platform in code
 * (see `checkProposalAgainstConstraints`); a model is never trusted to enforce them.
 */
export const platformConstraintsSchema = z
  .object({
    version: z.literal(1).default(1),
    limits: limitsSchema.default({}),
    hosting: hostingSchema.default({}),
    architecture: architectureSchema.default({}),
    productTypes: productTypesSchema.default({}),
    /** Business domains the owner excludes (for example regulated ones). */
    excludedDomains: orUnknown(z.array(z.string().min(1))),
    notes: orUnknown(z.string()),
  })
  .strict();
export type PlatformConstraints = z.infer<typeof platformConstraintsSchema>;
