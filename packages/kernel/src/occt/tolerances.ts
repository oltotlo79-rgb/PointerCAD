/**
 * 幾何形状が一致するとみなす基準(mm)。NFR-RE-3 の OCCT 既定値。
 *
 * 固定している OCCT WASM での実測値は `Precision.Confusion() = 1e-7 mm`、
 * `Precision.Angular() = 1e-12 rad`。`tolerances.test.ts` が両方を固定する。
 */
export const GEOMETRIC_CONFUSION_MM = 1e-7;

/** 面の縫合で隙間を修復する幅の既定値(mm)。model の既定値 0.01 mm と同じ。 */
export const DEFAULT_SEWING_REPAIR_TOLERANCE_MM = 0.01;

/** 文書の尺度で縫合の修復幅として受け付ける上限(mm)。 */
export const MAXIMUM_SEWING_REPAIR_TOLERANCE_MM = 1;

/** `BRepOffsetAPI_ThruSections` が近似曲面を作るときの `pres3d` 偏差(mm)。 */
export const THRU_SECTIONS_APPROXIMATION_TOLERANCE_MM = 1e-6;

/**
 * 表示メッシュの偏差は幾何公差や修復幅ではない。
 * 一般形状は `types.ts` の 0.1 mm / 0.5 rad、掃引体は
 * `worker/recomputeSolids.ts` の 0.15 mm / 0.7 rad を正本のまま使う。
 */

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
