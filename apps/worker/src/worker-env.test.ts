import { describe, expect, it } from 'vitest';
import {
  assertNoPrivateSigningKey,
  assertSupportedExecutionMode,
  readProviderApiKey,
} from './worker-env.js';

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
  it('accepts the mock and the OpenAI executors', () => {
    expect(() => assertSupportedExecutionMode('mock')).not.toThrow();
    expect(() => assertSupportedExecutionMode('openai')).not.toThrow();
  });

  it('refuses to start in a mode that is not implemented instead of failing at the first stage', () => {
    expect(() => assertSupportedExecutionMode('openhands')).toThrow(
      /EXECUTION_MODE=openhands is not available.*Set EXECUTION_MODE=mock or openai/,
    );
  });
});

describe('readProviderApiKey', () => {
  it('returns the key from the named variable', () => {
    expect(readProviderApiKey('OPENAI_API_KEY', { OPENAI_API_KEY: 'sk-live-value' })).toBe(
      'sk-live-value',
    );
  });

  it('names the missing variable, never any value, and treats empty as missing', () => {
    expect(() => readProviderApiKey('OPENAI_API_KEY', {})).toThrow(/OPENAI_API_KEY.*not set/);
    expect(() => readProviderApiKey('OPENAI_API_KEY', { OPENAI_API_KEY: '' })).toThrow(/not set/);
  });
});
