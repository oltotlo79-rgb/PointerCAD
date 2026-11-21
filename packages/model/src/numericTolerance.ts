/**
 * 数の大きさを許容差と比べる共通の口。許容差の比較を製品のあちこちに手書きで足さず、ここへ集める
 * (規約の検査 toleranceBaseline)。許容差の値は呼ぶ側が名前のある定数で渡す。
 * どれも |value| を bound と比べた時と同じ真偽を返し、value か bound が NaN の時は false。
 */

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
