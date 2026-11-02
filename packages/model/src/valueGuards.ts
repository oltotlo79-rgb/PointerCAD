/** Existing model record predicate; deliberately permits arbitrary object prototypes. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
