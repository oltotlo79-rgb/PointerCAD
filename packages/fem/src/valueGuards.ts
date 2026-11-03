export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Domain errors remain the caller's; negative zero is normalized unless preservation is requested. */
export function createFiniteReader(
  fail: (message: string) => never, zero: 'normalize' | 'preserve' = 'normalize',
): (value: unknown, path: string) => number {
  return (value, path) => {
    if (!isFiniteNumber(value)) fail(`${path} must be a finite number`);
    return zero === 'normalize' && value === 0 ? 0 : value;
  };
}

/** Construct domain errors at the caller's failure site, preserving its prefix. */
export function createPrefixedError(prefix: string): (message: string) => never {
  return message => { throw new Error(`${prefix}: ${message}`); };
}
