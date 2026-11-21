/**
 * 幾何形状が一致するとみなす基準(mm)。NFR-RE-3 の OCCT 既定値。
 *
 * 固定している OCCT WASM での実測値は `Precision.Confusion() = 1e-7 mm`、
 * `Precision.Angular() = 1e-12 rad`。`tolerances.test.ts` が両方を固定する。
 */
export const GEOMETRIC_CONFUSION_MM = 1e-7;

/** 近似曲面と断面の接続で使う許容差(mm)。文書の縫合修復幅とは別の基準。 */
export const APPROXIMATION_TOLERANCE_MM = 1e-6;

/** 文書の尺度で縫合の修復幅として受け付ける上限(mm)。 */
const MAXIMUM_SEWING_REPAIR_TOLERANCE_MM = 1;

/**
 * 表示メッシュの偏差は幾何公差や修復幅ではない。
 * 一般形状は `types.ts` の 0.1 mm / 0.5 rad、掃引体は
 * `worker/recomputeSolids.ts` の 0.15 mm / 0.7 rad を正本のまま使う。
 */

/**
 * 値の大きさ(絶対値)が許容差を超えるか(|value| > bound)。許容差の比較を製品のあちこちに手書きせず、
 * この 1 か所に集める共通の口(kernel の中だけで使う。kernel は model を読めないため ui・model とは別に置く)。
 * 許容差は呼ぶ側が名前のある定数で渡す。値か許容差が NaN の時は false(`Math.abs(value) > bound` と同じ真偽)。
 */
export function exceedsMagnitude(value: number, bound: number): boolean {
  return value > bound || value < -bound;
}

/** |value| ≤ bound。 */
export function withinMagnitude(value: number, bound: number): boolean {
  return -bound <= value && value <= bound;
}

/** |value| < bound。 */
export function belowMagnitude(value: number, bound: number): boolean {
  return -bound < value && value < bound;
}

/** |value| ≥ bound。NaN を含む場合は偽。 */
export function magnitudeAtLeast(value: number, bound: number): boolean {
  return value >= bound || value <= -bound;
}

/** 有限で正、かつ文書尺度に対して過大でない修復幅を返す。 */
export function validateToleranceMm(value: number): number {
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new Error('つなぎ目の許容量は 0 より大きい数にしてください。');
  }
  if (value > MAXIMUM_SEWING_REPAIR_TOLERANCE_MM) {
    throw new Error(
      `つなぎ目の許容量は ${MAXIMUM_SEWING_REPAIR_TOLERANCE_MM} mm 以下にしてください。`,
    );
  }
  return value;
}
