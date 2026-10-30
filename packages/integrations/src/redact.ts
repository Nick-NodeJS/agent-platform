const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /((?:api[_-]?key|secret|token|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];

export const REDACTED = '[REDACTED]';

export function redactString(value: string): string {
  return PATTERNS.reduce(
    (acc, re) =>
      acc.replace(re, (_m, prefix) => (typeof prefix === 'string' ? prefix : '') + REDACTED),
    value,
  );
}

/** Redacts secret-looking strings anywhere in a JSON-like value. Callers re-parse the result with their schema. */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]),
    );
  }
  return value;
}
