/** kernel の math/magnitude.ts と同じ定義。最下層では @pointercad/* を読み込めないため、パッケージごとに置く。 */

/** |value| ≤ bound。 */
export function withinMagnitude(value: number, bound: number): boolean {
  return -bound <= value && value <= bound;
}

/** |value| < bound。 */
export function belowMagnitude(value: number, bound: number): boolean {
  return -bound < value && value < bound;
}

/** |value| > bound。 */
export function exceedsMagnitude(value: number, bound: number): boolean {
  return value > bound || value < -bound;
}

/** |value| ≥ bound。NaN を含む場合は偽。 */
export function magnitudeAtLeast(value: number, bound: number): boolean {
  return value >= bound || value <= -bound;
}
