import { describe, expect, it } from 'vitest';
import { assertProfileConfigured, ProfileNotConfiguredError, ROLE_DEFINITIONS } from './index.js';

describe('model profile guard', () => {
  it('rejects the unconfigured placeholder profiles', () => {
    const profile = ROLE_DEFINITIONS.researcher?.modelProfile;
    if (!profile) {
      throw new Error('researcher role must be defined');
    }
    expect(() => assertProfileConfigured(profile, {})).toThrow(ProfileNotConfiguredError);
  });
  it('rejects missing credentials and zero budget', () => {
    const p = { provider: 'x', model: 'm', apiKeyEnvVar: 'K', maxSteps: 1, budget: { maxUsd: 1 } };
    expect(() => assertProfileConfigured(p, {})).toThrow(/not set/);
    expect(() => assertProfileConfigured({ ...p, budget: { maxUsd: 0 } }, { K: 'v' })).toThrow(
      /budget/,
    );
    expect(() => assertProfileConfigured(p, { K: 'v' })).not.toThrow();
  });
});
