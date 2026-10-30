import { z } from 'zod';
import { idSchema, timestampSchema } from './ids.js';

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const artifactRefSchema = z.object({ resultId: idSchema, digest: digestSchema }).strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

/** A review gate is bound to the exact artifacts (and content digests) the human is asked to review. */
export const reviewGateSchema = z
  .object({
    gateId: idSchema,
    runId: idSchema,
    artifacts: z.array(artifactRefSchema).min(1).max(20),
  })
  .strict();
export type ReviewGate = z.infer<typeof reviewGateSchema>;

export const APPROVAL_VERSION = 1;
export const MAX_APPROVAL_VALIDITY_MS = 15 * 60 * 1000;
export const APPROVAL_CLOCK_SKEW_MS = 60 * 1000;

export const approvalPayloadSchema = z
  .object({
    version: z.literal(APPROVAL_VERSION),
    decisionId: idSchema,
    runId: idSchema,
    gateId: idSchema,
    artifacts: z.array(artifactRefSchema).min(1).max(20),
    decision: z.enum(['approve', 'reject']),
    keyId: idSchema,
    actor: z.string().min(1).max(100),
    reason: z.string().max(1000).optional(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

export const approvalEnvelopeSchema = z
  .object({
    payload: approvalPayloadSchema,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .max(256),
  })
  .strict();
export type ApprovalEnvelope = z.infer<typeof approvalEnvelopeSchema>;

export const decisionAckSchema = z
  .object({
    accepted: z.literal(true),
    gateId: idSchema,
    decision: z.enum(['approve', 'reject']),
    decisionId: idSchema,
  })
  .strict();
export type DecisionAck = z.infer<typeof decisionAckSchema>;

/** Deterministic JSON with sorted keys; the byte string that is signed and digested. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Canonical JSON round-trip: a plain, key-sorted object safe to store and to digest. */
export function toCanonicalObject(value: unknown): Record<string, unknown> {
  return z.record(z.unknown()).parse(JSON.parse(canonicalJson(value)));
}

/** Order-insensitive equality of two artifact reference lists. */
export function sameArtifacts(a: ArtifactRef[], b: ArtifactRef[]): boolean {
  const norm = (x: ArtifactRef[]) =>
    canonicalJson([...x].sort((p, q) => (p.resultId < q.resultId ? -1 : 1)));
  return norm(a) === norm(b);
}

export type GateCheck =
  { ok: true; envelope: ApprovalEnvelope; gate: ReviewGate } | { ok: false; reason: string };

/**
 * Deterministic, I/O-free structural check of a decision against the currently open review gate.
 * Used by the workflow's Update validator (and again after asynchronous verification), so it must stay pure.
 * Cryptographic verification happens separately in an Activity.
 */
export function checkDecisionAgainstGate(
  raw: unknown,
  state: { runId: string; gate: ReviewGate | undefined; alreadyAccepted: boolean },
): GateCheck {
  const { runId, gate, alreadyAccepted } = state;
  if (!gate) {
    return {
      ok: false,
      reason: 'review gate is not open yet; submit a fresh decision once the run is waiting',
    };
  }
  if (alreadyAccepted) {
    return { ok: false, reason: 'a decision was already accepted for this gate' };
  }
  const parsed = approvalEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed approval envelope' };
  }
  const { payload } = parsed.data;
  if (payload.runId !== runId) {
    return { ok: false, reason: 'decision is for a different run' };
  }
  if (payload.gateId !== gate.gateId) {
    return { ok: false, reason: 'decision is for a different (stale) gate' };
  }
  if (!sameArtifacts(payload.artifacts, gate.artifacts)) {
    return { ok: false, reason: 'decision is for different artifacts than the current gate' };
  }
  return { ok: true, envelope: parsed.data, gate };
}
