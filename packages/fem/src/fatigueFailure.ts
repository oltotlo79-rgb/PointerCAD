/** Construct the shared fatigue failure shape without widening its domain code. */
export function fatigueFailure<Code extends string>(code: Code, path: string): {
  readonly ok: false;
  readonly code: Code;
  readonly path: string;
} {
  return { ok: false, code, path };
}
