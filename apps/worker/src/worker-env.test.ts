import { describe, expect, it } from 'vitest';
import { assertNoPrivateSigningKey } from './worker-env.js';

describe('assertNoPrivateSigningKey', () => {
  it('refuses to run when the private signer path is present in the worker environment', () => {
    expect(() =>
      assertNoPrivateSigningKey({ APPROVAL_SIGNER_FILE: '/home/me/signer.json' }),
    ).toThrow(/must not be set in the worker environment/);
  });

  it('allows environments that only carry the public trusted-signers file or an empty placeholder', () => {
    expect(() =>
      assertNoPrivateSigningKey({ APPROVAL_TRUSTED_SIGNERS_FILE: '/x/trusted.json' }),
    ).not.toThrow();
    expect(() => assertNoPrivateSigningKey({ APPROVAL_SIGNER_FILE: '' })).not.toThrow();
  });
});
