/** Oriented two-dimensional determinant, in the input coordinate order. */
export function crossVec2(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] * b[1] - a[1] * b[0];
}
