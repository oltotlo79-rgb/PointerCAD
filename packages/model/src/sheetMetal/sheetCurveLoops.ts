/** 板金の向き付き境界を端点格子で閉ループへつなぐ。接線分割と切欠きで共用する。 */
import { curveEnd, curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { distanceVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetLoopSignedArea, type SheetGeometryResult } from './panelGeometry.js';
export interface SheetClippedLoop { readonly curves: readonly ResolvedCurve[]; readonly kind: 'outer' | 'hole' }
const TOLERANCE_MM = 1e-7;

/** 近い端点を格子の隣接27セルだけで探す。大きな輪郭を二乗で走査しない。 */
export function sheetCurveStartIndex(curves: readonly ResolvedCurve[]): (point: Vec3) => readonly number[] {
  const cells = new Map<string, number[]>();
  const grid = (point: Vec3) => point.map((value) => Math.floor(value / TOLERANCE_MM));
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const [i, curve] of curves.entries()) {
    const [x, y, z] = grid(curveStart(curve)), id = key(x, y, z), list = cells.get(id);
    if (list === undefined) cells.set(id, [i]); else list.push(i);
  }
  return (point) => {
    const [x, y, z] = grid(point), found: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const i of cells.get(key(x + dx, y + dy, z + dz)) ?? [])
        if (distanceVec3(point, curveStart(curves[i])) <= TOLERANCE_MM) found.push(i);
    return found;
  };
}

export function collectSheetCurveLoops(curves: readonly ResolvedCurve[], normal: Vec3): SheetGeometryResult<readonly SheetClippedLoop[]> {
  const starts = sheetCurveStartIndex(curves), next: number[] = [], inbound = new Int32Array(curves.length);
  for (const curve of curves) {
    const matches = starts(curveEnd(curve));
    if (matches.length !== 1) return { ok: false, message: '切欠き後の輪郭が閉じないか、境界が接しています。位置と寸法を確認してください。' };
    next.push(matches[0]); inbound[matches[0]] += 1;
  }
  if (inbound.some((count) => count !== 1)) return { ok: false, message: '切欠き後の輪郭に重なった接続があります。' };
  const used = new Set<number>(), loops: SheetClippedLoop[] = [];
  for (let start = 0; start < curves.length; start++) {
    if (used.has(start)) continue;
    let current = start;
    const loop: ResolvedCurve[] = [];
    while (!used.has(current)) { used.add(current); loop.push(curves[current]); current = next[current]; }
    if (current !== start) return { ok: false, message: '切欠き後の輪郭の接続が周回していません。' };
    const area = sheetLoopSignedArea(loop, normal);
    if (!Number.isFinite(area)) return { ok: false, message: '切欠き後の輪郭の面積が扱える範囲を超えています。' };
    if (Math.abs(area) > TOLERANCE_MM ** 2) loops.push({ curves: loop, kind: area > 0 ? 'outer' : 'hole' });
  }
  return { ok: true, value: loops };
}
