/** 長さの許容(mm)。重心の一致に使う。 */
export const LINEAR_TOLERANCE_MM = 1e-6;
/** 面積・体積の相対許容。解析的な平面と円柱だけなので、積分の誤差はこれより十分小さい。 */
const RELATIVE_TOLERANCE = 1e-7;
export function nearlyEqual(a: number, b: number, scale: number): boolean {
  return Math.abs(a - b) <= Math.max(LINEAR_TOLERANCE_MM, Math.abs(scale) * RELATIVE_TOLERANCE);
}
