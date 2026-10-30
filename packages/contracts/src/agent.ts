import { z } from 'zod';

export const agentRoleSchema = z.enum([
  'researcher',
  'business-owner',
  'product-manager',
  'architect',
  'developer',
  'qa',
  'devops',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const modelProfileSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().url().optional(),
    apiKeyEnvVar: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an environment variable NAME, never the secret itself')
      .optional(),
    maxSteps: z.number().int().positive(),
    budget: z.object({ maxUsd: z.number().nonnegative() }).strict(),
  })
  .strict();
export type ModelProfile = z.infer<typeof modelProfileSchema>;

export const agentRoleDefinitionSchema = z
  .object({
    role: agentRoleSchema,
    instructions: z.string().min(1),
    tools: z.array(z.string()),
    modelProfile: modelProfileSchema,
  })
  .strict();
export type AgentRoleDefinition = z.infer<typeof agentRoleDefinitionSchema>;
