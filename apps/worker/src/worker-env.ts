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
 * Real agent execution does not exist yet. Starting a worker that would fail at the first agent stage, after the
 * run already reached RESEARCHING, is worse than refusing to start; a mode is never silently replaced by the mock.
 */
export function assertSupportedExecutionMode(mode: PlatformConfig['EXECUTION_MODE']): void {
  if (mode !== 'mock') {
    throw new Error(
      `EXECUTION_MODE=${mode} is not available: real agent execution is not implemented. Set EXECUTION_MODE=mock.`,
    );
  }
}
