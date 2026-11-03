/** Non-null objects including arrays; functions are not objects for this contract. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Non-null object predicate; arrays are deliberately excluded. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value);
}
