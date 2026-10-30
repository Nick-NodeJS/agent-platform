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
