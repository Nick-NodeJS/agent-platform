import type { PlatformConfig } from '@platform/contracts';

/**
 * The worker (and any agent process) must never hold the private approval signing key.
 * Refusing to start is an enforced check, not a prompt instruction.
 */
export function assertNoPrivateSigningKey(env: NodeJS.ProcessEnv): void {
  if (env['APPROVAL_SIGNER_FILE']) {
    throw new Error(
      'APPROVAL_SIGNER_FILE (private signing key) must not be set in the worker environment; it belongs only to the trusted human CLI',
    );
  }
}

/**
 * `mock` and `openai` are the executable modes. OpenHands is deferred: starting a worker that would fail at the first
 * agent stage, after the run already reached RESEARCHING, is worse than refusing to start. A mode is never silently
 * replaced by another one.
 */
export function assertSupportedExecutionMode(mode: PlatformConfig['EXECUTION_MODE']): void {
  if (mode === 'openhands') {
    throw new Error(
      'EXECUTION_MODE=openhands is not available: OpenHands execution is not implemented. Set EXECUTION_MODE=mock or openai.',
    );
  }
}

/** Real execution needs its credential in the worker's environment; only the variable NAME is ever reported. */
export function readProviderApiKey(apiKeyEnvVar: string, env: NodeJS.ProcessEnv): string {
  const key = env[apiKeyEnvVar];
  if (!key) {
    throw new Error(
      `EXECUTION_MODE=openai needs the API key in the environment variable ${apiKeyEnvVar}, which is not set`,
    );
  }
  return key;
}
