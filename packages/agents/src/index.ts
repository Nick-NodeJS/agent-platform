import {
  agentRoleDefinitionSchema,
  type AgentRole,
  type AgentRoleDefinition,
  type ModelProfile,
} from '@platform/contracts';

export const PLACEHOLDER_MODEL = 'REPLACE_WITH_USER_CONFIGURED_MODEL_ID';

/** Placeholder profile: provider/model are NOT real values and are rejected by assertProfileConfigured. */
const placeholderProfile = (maxUsd: number): ModelProfile => ({
  provider: 'unconfigured',
  model: PLACEHOLDER_MODEL,
  apiKeyEnvVar: 'PROVIDER_API_KEY_PLACEHOLDER',
  maxSteps: 20,
  budget: { maxUsd },
});

const define = (role: AgentRole, instructions: string, tools: string[]): AgentRoleDefinition =>
  agentRoleDefinitionSchema.parse({
    role,
    instructions,
    tools,
    modelProfile: placeholderProfile(0),
  });

/** Milestone 1 only defines the two roles used by the mock workflow. Other roles are deferred. */
export const ROLE_DEFINITIONS: Partial<Record<AgentRole, AgentRoleDefinition>> = {
  researcher: define(
    'researcher',
    'Investigate product opportunities within the human-provided resource limits. Do not invent constraints.',
    [],
  ),
  'business-owner': define(
    'business-owner',
    'Evaluate research proposals. Your evaluation is a recommendation, never a human approval.',
    [],
  ),
};

export class ProfileNotConfiguredError extends Error {}

/**
 * Enforced at the executor boundary before any real (paid) execution:
 * rejects placeholder profiles, missing credentials, and zero budgets.
 */
export function assertProfileConfigured(
  profile: ModelProfile,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (profile.provider === 'unconfigured' || profile.model === PLACEHOLDER_MODEL) {
    throw new ProfileNotConfiguredError('model profile is an unconfigured placeholder');
  }
  if (!profile.apiKeyEnvVar || !env[profile.apiKeyEnvVar]) {
    throw new ProfileNotConfiguredError(
      `credential env var ${profile.apiKeyEnvVar ?? '(none)'} is not set`,
    );
  }
  if (profile.budget.maxUsd <= 0) {
    throw new ProfileNotConfiguredError('profile budget must be greater than zero');
  }
}

export * from './policy.js';
