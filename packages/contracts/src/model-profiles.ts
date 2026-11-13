import { z } from 'zod';
import { EXECUTOR_CALL_LIMIT_MS } from './execution-limits.js';

const nonNegative = z.number().nonnegative();

/** Per-million-token and per-call prices, copied by hand from the provider's price list (see `asOf`). */
export const modelPricingSchema = z
  .object({
    inputPerMTokUsd: nonNegative,
    cachedInputPerMTokUsd: nonNegative,
    outputPerMTokUsd: nonNegative,
    webSearchPerCallUsd: nonNegative,
    /** A request with more input tokens than this is billed at the multipliers below, for the whole request. */
    longContextThresholdTokens: z.number().int().positive(),
    longContextInputMultiplier: z.number().min(1),
    longContextOutputMultiplier: z.number().min(1),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type ModelPricing = z.infer<typeof modelPricingSchema>;

const roleProfileSchema = z
  .object({
    model: z.string().min(1),
    reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
    /** Hard ceiling on generated tokens (reasoning included) for one call. */
    maxOutputTokens: z.number().int().positive(),
    /** Hard ceiling on tool calls (web searches) for one call; 0 when the role has no tools. */
    maxToolCalls: z.number().int().nonnegative(),
    searchContextSize: z.enum(['low', 'medium', 'high']),
    /** The only tools this role may use. Roles without `web_search` get no tools at all. */
    tools: z.array(z.literal('web_search')),
    /** Time limit for one provider call; always below the stage timeout (see execution-limits.ts). */
    timeoutMs: z.number().int().positive().max(EXECUTOR_CALL_LIMIT_MS),
  })
  .strict()
  .refine((role) => role.tools.length > 0 === role.maxToolCalls > 0, {
    message: 'maxToolCalls must be above 0 exactly when the role has tools',
  });

/** Names environment variables only; the secret itself never appears in a file. */
const envVarNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable NAME, never the secret itself');

export const modelProfilesSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('openai'),
    apiKeyEnvVar: envVarNameSchema,
    roles: z
      .object({ researcher: roleProfileSchema, 'business-owner': roleProfileSchema })
      .strict(),
    pricing: z.record(z.string().min(1), modelPricingSchema),
    spend: z
      .object({
        /** A call is not started with less than this left in the run or month budget. */
        minRemainingBudgetUsd: nonNegative,
        /** What an `uncertain` execution counts as when budgets are checked. */
        assumedUncertainCostUsd: nonNegative,
      })
      .strict(),
  })
  .strict()
  .superRefine((profiles, context) => {
    for (const [role, profile] of Object.entries(profiles.roles)) {
      if (!(profile.model in profiles.pricing)) {
        context.addIssue({
          code: 'custom',
          message: `no pricing for ${profile.model} (role ${role}); a model that cannot be priced cannot be budgeted`,
        });
      }
    }
  });
export type ModelProfiles = z.infer<typeof modelProfilesSchema>;
export type OpenAiRoleProfile = ModelProfiles['roles']['researcher'];
