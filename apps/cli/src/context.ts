import os from 'node:os';
import path from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { loadBaseConfig } from '@platform/contracts';

/** Everything a command needs from its environment, so commands can run in-process under test. */
export interface CliContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
  homeDir: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const defaultContext = (): CliContext => ({
  env: process.env,
  cwd: process.cwd(),
  homeDir: os.homedir(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});

/** A user-facing failure (bad input, not ready): printed without a stack trace and mapped to exit code 1. */
export class CliError extends Error {}

export const defaultApprovalDir = (ctx: CliContext) =>
  path.join(ctx.homeDir, '.config', 'agent-platform', 'approval');

export const signerFilePath = (ctx: CliContext) =>
  ctx.env['APPROVAL_SIGNER_FILE'] || path.join(defaultApprovalDir(ctx), 'signer.json');

export async function openTemporal(ctx: CliContext) {
  const config = loadBaseConfig(ctx.env);
  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  return {
    config,
    connection,
    client: new Client({ connection, namespace: config.TEMPORAL_NAMESPACE }),
  };
}

export const temporalUiUrl = (namespace: string, runId: string) =>
  `http://127.0.0.1:8233/namespaces/${namespace}/workflows/${runId}`;
