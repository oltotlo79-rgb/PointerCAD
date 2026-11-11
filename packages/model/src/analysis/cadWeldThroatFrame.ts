import { cylindricalWeldSection } from '../assembly/welding/cylindricalWeld.js';
import type { FilletWeldSegmentOptions } from '../assembly/welding/filletWeldPart.js';
import { WELD_LENGTH_TOLERANCE_MM, weldCrossSectionIssue, weldInteriorAngle } from '../assembly/welding/types.js';

type SectionOptions = Pick<FilletWeldSegmentOptions, 'interiorAngleDegrees' | 'cylindricalRadius' | 'cylindricalSide'>;

/** 保存した実断面の自由面への内点投影。曲がった溶接線や許容応力は推定しない。 */
export function cadWeldThroatFrame(a: number, b: number, options: SectionOptions): {
  readonly heightMm: number; readonly direction: readonly [number, number];
} | null {
  if (![a, b].every(v => Number.isFinite(v) && v > WELD_LENGTH_TOLERANCE_MM)) return null;
  const angle = options.interiorAngleDegrees === undefined ? null : weldInteriorAngle(options.interiorAngleDegrees);
  if (options.interiorAngleDegrees !== undefined && angle === null) return null;
  if (weldCrossSectionIssue(a, b, angle) !== null) return null;
  const radius = options.cylindricalRadius;
  if (options.cylindricalSide !== undefined && (options.cylindricalSide !== 'interior' || radius === undefined)) return null;
  if (radius !== undefined && angle !== null) return null;
  let px = a, py = 0, qx = angle === null ? 0 : b * angle.cos, qy = angle === null ? b : b * angle.sin;
  if (radius !== undefined) {
    const section = cylindricalWeldSection(radius, a, b, options.cylindricalSide);
    if (section === null) return null;
    [px, py] = section.toe;
    qx = 0; qy = b;
  }
  const vx = qx - px, vy = qy - py, scale = Math.max(Math.abs(px), Math.abs(py), Math.abs(qx), Math.abs(qy));
  // 無次元化して投影を求める。円の半径を弦長へ置換しない。
  const sx = vx / scale, sy = vy / scale;
  const lambda = -((px / scale) * sx + (py / scale) * sy) / (sx * sx + sy * sy);
  if (!Number.isFinite(lambda) || !(lambda > 0 && lambda < 1)) return null;
  const hx = px + lambda * vx, hy = py + lambda * vy, heightMm = Math.hypot(hx, hy);
  if (![hx, hy, heightMm].every(Number.isFinite) || heightMm <= WELD_LENGTH_TOLERANCE_MM) return null;
  if (radius !== undefined) {
    // 根元から tH (0<=t<=1) 全体の円に対する符号を二次式で確認する。
    // 外側: t²|H|²+2RtHy>=0。内側: t²|H|²-2RtHy<=0。
    // 自由面の内点Hと根元の凸結合は、その直線境界の材料側に留まる。
    if (hx < 0 || hx > px || (options.cylindricalSide === 'interior'
      ? Math.hypot(hx / radius, hy / radius - 1) > 1 : hy < 0)) return null;
  }
  return { heightMm, direction: [hx / heightMm, hy / heightMm] };
}
