import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  checkDecisionAgainstGate,
  sameArtifacts,
  toCanonicalObject,
  type ApprovalPayload,
  type ReviewGate,
} from './approval.js';
import { loadBaseConfig, loadConfig } from './config.js';
import { generateSigner, signApproval } from './node.js';

const digest = (char: string) => char.repeat(64);
const gate: ReviewGate = {
  gateId: 'gate-1',
  runId: 'run-1',
  artifacts: [
    { resultId: 'res-a', digest: digest('a') },
    { resultId: 'res-b', digest: digest('b') },
  ],
};

const signedDecision = (patch: Partial<ApprovalPayload> = {}) => {
  const { signer } = generateSigner('key-1', 'alice');
  const payload: ApprovalPayload = {
    version: 1,
    decisionId: 'dec-1',
    runId: gate.runId,
    gateId: gate.gateId,
    artifacts: gate.artifacts,
    decision: 'approve',
    keyId: 'key-1',
    actor: 'alice',
    issuedAt: '2026-01-01T12:00:00.000Z',
    expiresAt: '2026-01-01T12:05:00.000Z',
    ...patch,
  };
  return signApproval(payload, signer);
};

const open = { runId: 'run-1', gate, alreadyAccepted: false };

describe('checkDecisionAgainstGate (workflow-side structural check)', () => {
  it('accepts a decision for the open gate and returns the parsed envelope with the gate', () => {
    const check = checkDecisionAgainstGate(signedDecision(), open);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.gate).toBe(gate);
      expect(check.envelope.payload.decisionId).toBe('dec-1');
    }
  });

  it('accepts artifacts listed in a different order', () => {
    const reordered = signedDecision({ artifacts: [...gate.artifacts].reverse() });
    expect(checkDecisionAgainstGate(reordered, open).ok).toBe(true);
  });

  it.each([
    ['no gate open yet', { ...open, gate: undefined }, signedDecision(), /not open yet/],
    [
      'a decision was already accepted',
      { ...open, alreadyAccepted: true },
      signedDecision(),
      /already accepted/,
    ],
    ['malformed payload', open, { nonsense: true }, /malformed/],
    ['another run', { ...open, runId: 'run-2' }, signedDecision(), /different run/],
    ['another gate', open, signedDecision({ gateId: 'gate-0' }), /stale\) gate/],
    [
      'different artifact digests',
      open,
      signedDecision({
        artifacts: [
          { resultId: 'res-a', digest: digest('c') },
          { resultId: 'res-b', digest: digest('b') },
        ],
      }),
      /different artifacts/,
    ],
  ])('rejects: %s', (_name, state, raw, reason) => {
    const check = checkDecisionAgainstGate(raw, state);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toMatch(reason);
    }
  });
});

describe('canonical JSON helpers', () => {
  it('sorts keys at every depth and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  });

  it('toCanonicalObject returns a plain object and rejects non-objects', () => {
    expect(toCanonicalObject({ z: 1, a: 2 })).toEqual({ a: 2, z: 1 });
    expect(() => toCanonicalObject('text')).toThrow();
  });

  it('sameArtifacts compares set-wise with digests', () => {
    expect(sameArtifacts(gate.artifacts, [...gate.artifacts].reverse())).toBe(true);
    expect(sameArtifacts(gate.artifacts, gate.artifacts.slice(0, 1))).toBe(false);
  });
});

describe('configuration boundary', () => {
  const database = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/db' };

  it('loadBaseConfig works without a database and applies local defaults', () => {
    const config = loadBaseConfig({});
    expect(config.TEMPORAL_ADDRESS).toBe('127.0.0.1:7233');
    expect(config.AGENT_LEASE_TTL_MS).toBe(120_000);
  });

  it('rejects an invalid lease TTL and a missing database URL', () => {
    expect(() => loadConfig({ ...database, AGENT_LEASE_TTL_MS: '10' })).toThrow();
    expect(() => loadConfig({})).toThrow();
  });

  it('openhands mode passes only when its own settings are present', () => {
    const openhands = {
      ...database,
      EXECUTION_MODE: 'openhands',
      OPENHANDS_AGENT_SERVER_URL: 'http://127.0.0.1:8000',
      OPENHANDS_SESSION_API_KEY: 'dummy-session-key',
    };
    expect(loadConfig(openhands).EXECUTION_MODE).toBe('openhands');
  });
});
