/** 板金の平面輪郭から矩形/長穴を引く。外周・穴を向き付きの解析曲線としてつなぎ直す。 */
import { curveEnd, curvePointAt, curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { crossVec3, dotVec3, normalizeVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { groupClippedPanels, sheetLoopContains } from './groupClippedPanels.js';
import { orientSheetLoop, type SheetGeometryResult, type SheetPanelGeometry } from './panelGeometry.js';
import { reliefBoundaryParameter, reliefIntersections, type ReliefBoundary } from './reliefIntersections.js';
import { collectSheetCurveLoops } from './sheetCurveLoops.js';
import { sliceSheetCurve } from './sliceSheetCurve.js';

function reverse(curve: ResolvedCurve): ResolvedCurve {
  if (curve.kind === 'segment') return { ...curve, from: curve.to, to: curve.from };
  if (curve.kind === 'spline') return { ...curve, points: [...curve.points].reverse() };
  return { ...curve, startAngle: curve.endAngle, endAngle: curve.startAngle };
}
function orderedCuts(cuts: readonly number[]): readonly number[] {
  return [...cuts].sort((a, b) => a - b).filter((value, index, sorted) => index === 0 || value - sorted[index - 1] > 16 * Number.EPSILON);
}

export function subtractSheetRelief(panel: SheetPanelGeometry, tool: readonly ReliefBoundary[], featureId: string): SheetGeometryResult<readonly SheetPanelGeometry[]> {
  const outer = orientSheetLoop(panel.outer, panel.normal), holes = panel.holes.map((loop) => orientSheetLoop(loop, panel.normal, true));
  const toolLoop = orientSheetLoop(tool, panel.normal);
  if (outer === null || holes.some((loop) => loop === null) || toolLoop === null)
    return { ok: false, message: '切欠きの形か元の板金輪郭が閉じていません。' };
  const cutter: ReliefBoundary[] = [];
  for (const curve of toolLoop) {
    if (curve.kind !== 'segment' && curve.kind !== 'arc') return { ok: false, message: '切欠きには矩形か長穴を指定してください。' };
    cutter.push(curve);
  }
  const source = [outer, ...holes].flatMap((loop) => loop ?? []);
  const sourceCuts = source.map(() => [0, 1]), toolCuts = cutter.map(() => [0, 1]);
  for (const [i, curve] of source.entries()) for (const [j, edge] of cutter.entries()) {
    const intersections = reliefIntersections(curve, edge, panel.normal); if (!intersections.ok) return intersections;
    for (const hit of intersections.value) { sourceCuts[i].push(hit.source); toolCuts[j].push(hit.tool); }
  }
  const seed: Vec3 = Math.abs(panel.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const ray = normalizeVec3(crossVec3(seed, panel.normal)), up = crossVec3(panel.normal, ray);
  const insideSource = (point: Vec3): SheetGeometryResult<boolean> => {
    const exterior = sheetLoopContains(outer, point, ray, up); if (!exterior.ok || !exterior.value) return exterior;
    for (const hole of holes) {
      if (hole === null) continue;
      const interior = sheetLoopContains(hole, point, ray, up); if (!interior.ok) return interior;
      if (interior.value) return { ok: true, value: false };
    }
    return { ok: true, value: true };
  };
  const result: ResolvedCurve[] = []; let changed = false;
  for (const [i, curve] of source.entries()) {
    const cuts = orderedCuts(sourceCuts[i]);
    for (let k = 1; k < cuts.length; k++) {
      const a = cuts[k - 1], b = cuts[k], middle = curvePointAt(curve, (a + b) / 2);
      const boundary = cutter.find((edge) => reliefBoundaryParameter(edge, middle) !== null);
      const inside = sheetLoopContains(cutter, middle, ray, up); if (!inside.ok) return inside;
      const sameSide = boundary !== undefined && dotVec3(subVec3(curvePointAt(curve, b), curvePointAt(curve, a)),
        subVec3(curveEnd(boundary), curveStart(boundary))) >= 0;
      if (boundary === undefined ? inside.value : sameSide) { changed = true; continue; }
      const pieces = sliceSheetCurve(curve, a, b); if (!pieces.ok) return pieces;
      result.push(...pieces.value);
    }
  }
  for (const [i, curve] of cutter.entries()) {
    const cuts = orderedCuts(toolCuts[i]);
    for (let k = 1; k < cuts.length; k++) {
      const a = cuts[k - 1], b = cuts[k], middle = curvePointAt(curve, (a + b) / 2);
      // 工具が元の直線境界に接する区間は元側で判定済み。工具を逆向きに重ねない。
      if (source.some((edge) => edge.kind === 'segment' && reliefBoundaryParameter(edge, middle) !== null)) continue;
      const inside = insideSource(middle); if (!inside.ok) return inside;
      if (!inside.value) continue;
      const pieces = sliceSheetCurve(curve, a, b); if (!pieces.ok) return pieces;
      changed = true; result.push(...pieces.value.map(reverse));
    }
  }
  if (!changed) return { ok: true, value: [panel] };
  const loops = collectSheetCurveLoops(result, panel.normal); if (!loops.ok) return loops;
  return groupClippedPanels(loops.value, panel.normal, up, featureId);
}
