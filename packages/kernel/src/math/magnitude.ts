/**
 * 数の大きさ(絶対値)を許容差と比べる共通の口。許容差の比較を製品のあちこちに手書きせず、この 1 か所に集める
 * (eslint の tolerance/comparison と、packages/test-utils の toleranceBaseline の検査)。許容差の値は呼ぶ側が名前のある定数で渡す。
 * どれも |value| を bound と比べた時と同じ真偽を返し、value か bound が NaN の時は false。
 *
 * このファイルは何も import しない。kernel の中の呼出し側は `occt/tolerances.ts` が出し直す名前で読み、model は明示の
 * subpath `@pointercad/kernel/math/magnitude` を、橋 `kernelBridge/magnitudeMath.ts` だけを通して読む(model の
 * `numericTolerance.ts` が出し直す)。kernel の index・OCCT・Worker を読み込む経路を作らないためで、FEM の Worker が
 * model の `beam-analysis` の入口から読んでも OCCT の初期化は起きない。
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
