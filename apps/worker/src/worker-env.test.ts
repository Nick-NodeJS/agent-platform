import { describe, expect, it } from 'vitest';
import { assertNoPrivateSigningKey, assertSupportedExecutionMode } from './worker-env.js';

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

describe('assertSupportedExecutionMode', () => {
  it('accepts the mock executor', () => {
    expect(() => assertSupportedExecutionMode('mock')).not.toThrow();
  });

  it('refuses to start in a mode whose real execution is not implemented instead of failing at the first stage', () => {
    expect(() => assertSupportedExecutionMode('openhands')).toThrow(
      /EXECUTION_MODE=openhands is not available.*Set EXECUTION_MODE=mock/,
    );
  });
});
