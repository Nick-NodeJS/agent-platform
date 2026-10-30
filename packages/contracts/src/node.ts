// Node-only helpers (crypto, fs). NOT exported from the package index: the workflow bundle must never import this.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  APPROVAL_CLOCK_SKEW_MS,
  APPROVAL_VERSION,
  MAX_APPROVAL_VALIDITY_MS,
  approvalEnvelopeSchema,
  canonicalJson,
  sameArtifacts,
  type ApprovalEnvelope,
  type ApprovalPayload,
  type ReviewGate,
} from './approval.js';
import { idSchema } from './ids.js';

export const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');
export const digestPayload = (payload: unknown): string => sha256Hex(canonicalJson(payload));

const DOMAIN = 'agent-platform/approval/v1\n';

export const trustedSignerSchema = z
  .object({ keyId: idSchema, actor: z.string().min(1).max(100), publicKeyPem: z.string().min(1) })
  .strict();
export type TrustedSigner = z.infer<typeof trustedSignerSchema>;

/** Human-held signer file. Contains the PRIVATE key: keep it outside the repo, agent mounts, and worker env. */
export const signerFileSchema = z
  .object({
    keyId: idSchema,
    actor: z.string().min(1).max(100),
    privateKeyPem: z.string().min(1),
  })
  .strict();
export type SignerFile = z.infer<typeof signerFileSchema>;

export function generateSigner(
  keyId: string,
  actor: string,
): { signer: SignerFile; trusted: TrustedSigner } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    signer: {
      keyId,
      actor,
      privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    },
    trusted: {
      keyId,
      actor,
      publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    },
  };
}

export function signApproval(payload: ApprovalPayload, signer: SignerFile): ApprovalEnvelope {
  if (payload.keyId !== signer.keyId || payload.actor !== signer.actor)
    throw new Error('payload signer identity does not match signer file');
  const signature = sign(
    null,
    Buffer.from(DOMAIN + canonicalJson(payload)),
    createPrivateKey(signer.privateKeyPem),
  ).toString('base64');
  return { payload, signature };
}

export function loadTrustedSigners(file: string): TrustedSigner[] {
  return z.array(trustedSignerSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
}

export function loadSignerFile(file: string): SignerFile {
  return signerFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

export class ApprovalRejectedError extends Error {}

export interface VerifyContext {
  gate: ReviewGate;
  trusted: TrustedSigner[];
  now: Date;
}

/**
 * Verifies schema, signer (actor derived from trusted config), signature, run/gate/artifact scope and expiry.
 * Replay handling (decisionId already used) is done by the caller against the database.
 */
export function verifyApproval(
  raw: unknown,
  { gate, trusted, now }: VerifyContext,
): { payload: ApprovalPayload; actor: string; keyId: string; envelopeDigest: string } {
  const parsed = approvalEnvelopeSchema.safeParse(raw);
  if (!parsed.success) throw new ApprovalRejectedError('malformed approval envelope');
  const { payload, signature } = parsed.data;
  if (payload.version !== APPROVAL_VERSION) throw new ApprovalRejectedError('unsupported version');

  const signer = trusted.find((s) => s.keyId === payload.keyId);
  if (!signer) throw new ApprovalRejectedError('unknown signer key');
  if (signer.actor !== payload.actor)
    throw new ApprovalRejectedError('actor does not match trusted signer');

  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(DOMAIN + canonicalJson(payload)),
      createPublicKey(signer.publicKeyPem),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new ApprovalRejectedError('invalid signature');

  if (payload.runId !== gate.runId || payload.gateId !== gate.gateId)
    throw new ApprovalRejectedError('approval is for a different run or gate');
  if (!sameArtifacts(payload.artifacts, gate.artifacts))
    throw new ApprovalRejectedError('approval is for different artifacts');

  const issued = Date.parse(payload.issuedAt);
  const expires = Date.parse(payload.expiresAt);
  if (expires - issued > MAX_APPROVAL_VALIDITY_MS || expires <= issued)
    throw new ApprovalRejectedError('invalid validity window');
  if (now.getTime() > expires) throw new ApprovalRejectedError('approval expired');
  if (issued > now.getTime() + APPROVAL_CLOCK_SKEW_MS)
    throw new ApprovalRejectedError('approval issued in the future');

  return {
    payload,
    actor: signer.actor,
    keyId: signer.keyId,
    envelopeDigest: digestPayload({ payload, signature }),
  };
}
