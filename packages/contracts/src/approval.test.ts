import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { ApprovalPayload, ReviewGate } from './approval.js';
import { canonicalJson } from './approval.js';
import { generateSigner, signApproval, verifyApproval, type TrustedSigner } from './node.js';

const digest = (c: string) => c.repeat(64);
const gate: ReviewGate = {
  gateId: 'gate-1',
  runId: 'run-1',
  artifacts: [
    { resultId: 'res-a', digest: digest('a') },
    { resultId: 'res-b', digest: digest('b') },
  ],
};
const T0 = new Date('2026-01-01T12:00:00.000Z');
const iso = (ms: number) => new Date(T0.getTime() + ms).toISOString();

function setup() {
  const { signer, trusted } = generateSigner('key-1', 'alice');
  const payload: ApprovalPayload = {
    version: 1,
    decisionId: 'dec-1',
    runId: gate.runId,
    gateId: gate.gateId,
    artifacts: gate.artifacts,
    decision: 'approve',
    keyId: 'key-1',
    actor: 'alice',
    issuedAt: iso(-1000),
    expiresAt: iso(5 * 60_000),
  };
  return { signer, trusted, payload };
}
const ctx = (trusted: TrustedSigner[], now = T0) => ({ gate, trusted, now });

describe('approval envelope verification', () => {
  it('accepts a correctly signed decision for the current gate', () => {
    const { signer, trusted, payload } = setup();
    const v = verifyApproval(signApproval(payload, signer), ctx([trusted]));
    expect(v.actor).toBe('alice');
    expect(v.keyId).toBe('key-1');
  });

  it('rejects forged unsigned payloads (source: human is meaningless)', () => {
    const { trusted, payload } = setup();
    expect(() =>
      verifyApproval({ payload, signature: 'AAAA', source: 'human' }, ctx([trusted])),
    ).toThrow();
    expect(() => verifyApproval({ ...payload, source: 'human' }, ctx([trusted]))).toThrow(
      /malformed/,
    );
    expect(() => verifyApproval({ payload, signature: 'AAAA' }, ctx([trusted]))).toThrow(
      /signature/,
    );
  });

  it('rejects altered signed content', () => {
    const { signer, trusted, payload } = setup();
    const env = signApproval({ ...payload, decision: 'reject' }, signer);
    expect(() =>
      verifyApproval({ ...env, payload: { ...env.payload, decision: 'approve' } }, ctx([trusted])),
    ).toThrow(/signature/);
    const env2 = signApproval(payload, signer);
    expect(() =>
      verifyApproval({ ...env2, payload: { ...env2.payload, reason: 'sneaky' } }, ctx([trusted])),
    ).toThrow(/signature/);
  });

  it('rejects a signer that is not trusted, and actor mismatches', () => {
    const { signer, payload } = setup();
    const other = generateSigner('key-1', 'alice'); // same keyId, different key
    expect(() => verifyApproval(signApproval(payload, signer), ctx([other.trusted]))).toThrow(
      /signature/,
    );
    expect(() => verifyApproval(signApproval(payload, signer), ctx([]))).toThrow(/unknown signer/);
    const { trusted } = generateSigner('key-1', 'mallory');
    expect(() =>
      verifyApproval(
        signApproval(payload, signer),
        ctx([{ ...trusted, publicKeyPem: other.trusted.publicKeyPem }]),
      ),
    ).toThrow(/actor/);
  });

  it('cannot self-assert a different actor than the trusted signer config', () => {
    const { signer, trusted, payload } = setup();
    const evilSigner = { ...signer, actor: 'bob' };
    const env = signApproval({ ...payload, actor: 'bob' }, evilSigner);
    expect(() => verifyApproval(env, ctx([trusted]))).toThrow(/actor/);
  });

  it('rejects expired, future-dated, and over-long validity windows', () => {
    const { signer, trusted, payload } = setup();
    const env = signApproval(payload, signer);
    expect(() => verifyApproval(env, ctx([trusted], new Date(T0.getTime() + 6 * 60_000)))).toThrow(
      /expired/,
    );
    expect(() =>
      verifyApproval(
        signApproval(
          { ...payload, issuedAt: iso(10 * 60_000), expiresAt: iso(12 * 60_000) },
          signer,
        ),
        ctx([trusted]),
      ),
    ).toThrow(/future/);
    expect(() =>
      verifyApproval(
        signApproval({ ...payload, expiresAt: iso(60 * 60_000) }, signer),
        ctx([trusted]),
      ),
    ).toThrow(/validity/);
  });

  it('rejects wrong run, wrong gate, and different artifacts', () => {
    const { signer, trusted, payload } = setup();
    const [first, second] = gate.artifacts;
    if (!first || !second) {
      throw new Error('fixture gate needs two artifacts');
    }
    for (const patch of [
      { runId: 'run-2' },
      { gateId: 'gate-2' },
      { artifacts: [{ resultId: 'res-a', digest: digest('c') }, second] },
      { artifacts: [first] },
    ]) {
      expect(() =>
        verifyApproval(signApproval({ ...payload, ...patch }, signer), ctx([trusted])),
      ).toThrow(/different/);
    }
  });

  it('signature is bound to the full canonical content (key order independent)', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('generated keys are ephemeral Ed25519 and private key never appears in the trusted file', () => {
    const { trusted } = generateSigner('k', 'a');
    expect(JSON.stringify(trusted)).not.toContain('PRIVATE');
    expect(generateKeyPairSync('ed25519').publicKey.asymmetricKeyType).toBe('ed25519');
  });

  it('refuses to sign a payload whose identity differs from the signer file', () => {
    const { signer, payload } = setup();
    expect(() => signApproval({ ...payload, actor: 'bob' }, signer)).toThrow(
      /does not match signer/,
    );
    expect(() => signApproval({ ...payload, keyId: 'other-key' }, signer)).toThrow(
      /does not match signer/,
    );
  });

  it('treats an unusable trusted public key as an invalid signature instead of crashing', () => {
    const { signer, trusted, payload } = setup();
    const broken: TrustedSigner = { ...trusted, publicKeyPem: 'not a pem' };
    expect(() => verifyApproval(signApproval(payload, signer), ctx([broken]))).toThrow(
      /invalid signature/,
    );
  });
});
