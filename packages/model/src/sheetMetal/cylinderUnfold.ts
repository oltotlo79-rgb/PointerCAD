/** P10-15/16。平面の剛体展開と共有する接線座標へ写す。 */
export type SheetPoint3 = readonly [number, number, number];
export type SheetPoint2 = readonly [number, number];
export interface CylindricalBendFrame {
  /** 曲げ開始接線の円筒軸上の点。 */
  readonly center: SheetPoint3;
  readonly axis: SheetPoint3;
  /** 開始接線で軸から内面へ向く単位ベクトル。 */
  readonly startRadius: SheetPoint3;
  readonly innerRadius: number;
  readonly thickness: number;
  readonly kFactor: number;
  /** 右手系の曲げ量。0 < abs(angleRadians) < pi。 */
  readonly angleRadians: number;
}
export type CylindricalPointResult = { readonly ok: true; readonly point: SheetPoint2 }
  | { readonly ok: false; readonly error: 'frame' | 'outsideThickness' | 'outsideBend' };
const dot = (a: SheetPoint3, b: SheetPoint3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: SheetPoint3, b: SheetPoint3): SheetPoint3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 厚み方向は中立面へ投影し、軸距離と角距離を維持する。塑性変形の予測ではない。 */
export function unfoldCylindricalPoint(point: SheetPoint3, frame: CylindricalBendFrame, toleranceMm = 1e-7): CylindricalPointResult {
  const { center, axis, startRadius, innerRadius: r, thickness: t, kFactor: k, angleRadians: angle } = frame;
  const neutralRadius = r + k * t;
  if (![...point, ...center, ...axis, ...startRadius, r, t, k, angle, toleranceMm].every(Number.isFinite)
    || toleranceMm <= 0 || r <= toleranceMm || t <= toleranceMm || k < 0 || k > 0.5
    || Math.abs(angle) <= Number.EPSILON || Math.abs(angle) >= Math.PI
    || Math.abs(dot(axis, axis) - 1) > 1e-10 || Math.abs(dot(startRadius, startRadius) - 1) > 1e-10
    || Math.abs(dot(axis, startRadius)) > 1e-10
    || ![r + t, neutralRadius, neutralRadius * Math.abs(angle)].every(Number.isFinite)) return { ok: false, error: 'frame' };
  const offset: SheetPoint3 = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
  const axial = dot(offset, axis);
  const radial: SheetPoint3 = [offset[0] - axial * axis[0], offset[1] - axial * axis[1], offset[2] - axial * axis[2]];
  const radius = Math.hypot(...radial);
  if (!Number.isFinite(radius) || radius < r - toleranceMm || radius > r + t + toleranceMm)
    return { ok: false, error: 'outsideThickness' };
  const tangent = cross(axis, startRadius);
  const swept = Math.atan2(dot(radial, tangent), dot(radial, startRadius)) * Math.sign(angle);
  const angleTolerance = toleranceMm / r;
  if (swept < -angleTolerance || swept > Math.abs(angle) + angleTolerance)
    return { ok: false, error: 'outsideBend' };
  // 境界の誤差だけを吸収する。範囲外の穴を板の中へ押し込まない。
  if (!Number.isFinite(axial)) return { ok: false, error: 'frame' };
  return { ok: true, point: [axial, neutralRadius * Math.max(0, Math.min(Math.abs(angle), swept))] };
}
