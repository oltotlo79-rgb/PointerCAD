/** 穴を含む板金面を接線で分割し、交差した穴を外周の切欠きへつなぐ。 */
import { curveEnd, curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { crossVec3, dotVec3, type Vec3 } from '../sketch/vec3.js';
import { orientSheetLoop, type SheetGeometryResult, type SheetPanelGeometry } from './panelGeometry.js';
import { splitSheetCurveAtPlane, type SheetSplitPlane } from './splitCurveAtPlane.js';

import { collectSheetCurveLoops, sheetCurveStartIndex, type SheetClippedLoop } from './sheetCurveLoops.js';
export type { SheetClippedLoop } from './sheetCurveLoops.js';
interface OpenEnd { readonly index: number; readonly start: boolean; readonly point: Vec3 }

export function clipSheetPanel(panel: SheetPanelGeometry, plane: SheetSplitPlane, keepSide: -1 | 1, cutId: string): SheetGeometryResult<readonly SheetClippedLoop[]> {
  if (!Number.isFinite(dotVec3(panel.normal, plane.normal)) || Math.abs(dotVec3(panel.normal, plane.normal)) > 1e-10)
    return { ok: false, message: '分割線を板金パネルと同じ平面に指定してください。' };
  const outer = orientSheetLoop(panel.outer, panel.normal), holes = panel.holes.map((loop) => orientSheetLoop(loop, panel.normal, true));
  if (outer === null || holes.some((loop) => loop === null)) return { ok: false, message: '分割する板金の外周か穴が閉じていません。' };
  const curves: ResolvedCurve[] = [];
  for (const loop of [outer, ...holes]) {
    if (loop === null) continue;
    for (const curve of loop) {
      const result = splitSheetCurveAtPlane(curve, plane); if (!result.ok) return result;
      for (const piece of result.value) if (piece.side === keepSide || piece.side === 0) curves.push(piece.curve);
    }
  }
  if (curves.length === 0) return { ok: true, value: [] };
  const starts = sheetCurveStartIndex(curves), next = Array.from({ length: curves.length }, () => -1), inbound = new Int32Array(curves.length);
  for (const [i, curve] of curves.entries()) {
    const matches = starts(curveEnd(curve));
    if (matches.length > 1) return { ok: false, message: '分割線が輪郭の分岐か接触点を通ります。線の位置を変更してください。' };
    if (matches.length === 1) { next[i] = matches[0]; inbound[matches[0]] += 1; }
  }
  const open: OpenEnd[] = [];
  for (const [i, curve] of curves.entries()) {
    if (inbound[i] > 1) return { ok: false, message: '分割後の輪郭に重なった端点があります。' };
    if (inbound[i] === 0) open.push({ index: i, start: true, point: curveStart(curve) });
    if (next[i] === -1) open.push({ index: i, start: false, point: curveEnd(curve) });
  }
  const axis = crossVec3(plane.normal, panel.normal);
  open.sort((a, b) => dotVec3(a.point, axis) - dotVec3(b.point, axis));
  if (open.length % 2 !== 0) return { ok: false, message: '分割線上の輪郭の端が対応していません。' };
  for (let i = 0; i < open.length; i += 2) {
    const a = open[i], b = open[i + 1];
    if (a.start === b.start) return { ok: false, message: '分割後の外周と穴の向きが対応していません。' };
    const [from, to] = a.start ? [b, a] : [a, b];
    curves.push({ kind: 'segment', featureId: JSON.stringify(['sheet-cut', cutId, keepSide, i / 2]), from: from.point, to: to.point });
  }
  return collectSheetCurveLoops(curves, panel.normal);
}
