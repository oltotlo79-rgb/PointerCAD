/** Existing model record predicate; deliberately permits arbitrary object prototypes. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A finite primitive number; no coercion or range restriction. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function hasExactOwnKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Domain errors remain the caller's; model keeps the supplied signed zero. */
export function createFiniteReader(fail: (path: string, message: string) => never): (value: unknown, path: string) => number {
  return (value, path) => {
    if (!isFiniteNumber(value)) fail(path, 'Expected a finite number');
    return value;
  };
}
