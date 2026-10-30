import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { idSchema } from '@platform/contracts';
import { generateSigner } from '@platform/contracts/node';
import type { ParsedArgs } from '../args.js';
import { CliError, defaultApprovalDir, type CliContext } from '../context.js';

const KEY_ID_RANDOM_CHARS = 8;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PUBLIC_FILE_MODE = 0o644;

const isInside = (parent: string, candidate: string) =>
  candidate === parent || candidate.startsWith(parent + path.sep);

/** Explicit setup command: keys are never generated automatically, and never inside the repository. */
export function keygenCommand(ctx: CliContext, { flags }: ParsedArgs): void {
  const actor = flags['actor'];
  if (!actor) {
    throw new CliError('--actor is required');
  }
  const keyId = idSchema.parse(
    flags['key-id'] ?? `key-${randomUUID().slice(0, KEY_ID_RANDOM_CHARS)}`,
  );
  const dir = path.resolve(flags['dir'] ?? defaultApprovalDir(ctx));
  const repoRoot = path.resolve(ctx.cwd);
  if (isInside(repoRoot, dir)) {
    throw new CliError(
      `refusing to write keys inside the repository (${repoRoot}); choose --dir outside it`,
    );
  }
  const signerFile = path.join(dir, 'signer.json');
  const trustedFile = path.join(dir, 'trusted-signers.json');
  if (existsSync(signerFile) || existsSync(trustedFile)) {
    throw new CliError(
      `keys already exist in ${dir}; refusing to overwrite (choose another --dir)`,
    );
  }

  const { signer, trusted } = generateSigner(keyId, actor);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  writeFileSync(signerFile, JSON.stringify(signer, null, 2), {
    mode: PRIVATE_FILE_MODE,
    flag: 'wx',
  });
  writeFileSync(trustedFile, JSON.stringify([trusted], null, 2), {
    mode: PUBLIC_FILE_MODE,
    flag: 'wx',
  });
  ctx.out(`private signer (keep secret; human CLI only): ${signerFile}`);
  ctx.out(`public trusted-signers file (for the worker):  ${trustedFile}`);
  ctx.out(`Set in .env (worker):  APPROVAL_TRUSTED_SIGNERS_FILE=${trustedFile}`);
  ctx.out('Do NOT put the private signer path in the shared .env or any agent/worker environment.');
  ctx.out(
    `The CLI finds the signer at ${path.join(defaultApprovalDir(ctx), 'signer.json')} by default, or via APPROVAL_SIGNER_FILE in your own shell.`,
  );
}
