/** 分割された複数の外周へ、残った穴を厳密な曲線交差で所属させる。 */
import { curveEnd, curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { crossVec3, dotVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import type { SheetClippedLoop } from './sheetCurveLoops.js';
import type { SheetGeometryResult, SheetPanelGeometry } from './panelGeometry.js';
import { splitSheetCurveAtPlane, type SheetCurvePiece } from './splitCurveAtPlane.js';

/** 境界上でない点の巻数。接するだけの根や水平辺を二重計数しない。 */
export function sheetLoopContains(loop: readonly ResolvedCurve[], point: Vec3, ray: Vec3, up: Vec3): SheetGeometryResult<boolean> {
  const pieces: SheetCurvePiece[] = [];
  for (const curve of loop) {
    const split = splitSheetCurveAtPlane(curve, { origin: point, normal: up });
    if (!split.ok) return split;
    pieces.push(...split.value.filter((piece) => piece.side !== 0));
  }
  let winding = 0;
  for (const [i, current] of pieces.entries()) {
    const next = pieces[(i + 1) % pieces.length];
    if (current.side === next.side) continue;
    const crossing = curveEnd(current.curve);
    if (dotVec3(subVec3(crossing, point), ray) > 1e-7) winding += current.side < next.side ? 1 : -1;
  }
  return { ok: true, value: winding !== 0 };
}

export function groupClippedPanels(loops: readonly SheetClippedLoop[], normal: Vec3, cutNormal: Vec3, id: string): SheetGeometryResult<readonly SheetPanelGeometry[]> {
  const outers = loops.filter((loop) => loop.kind === 'outer');
  const holes = outers.map((): (readonly ResolvedCurve[])[] => []), ray = crossVec3(cutNormal, normal);
  for (const hole of loops.filter((loop) => loop.kind === 'hole')) {
    const point = curveStart(hole.curves[0]), matches: number[] = [];
    for (const [i, outer] of outers.entries()) {
      const result = sheetLoopContains(outer.curves, point, ray, cutNormal); if (!result.ok) return result;
      if (result.value) matches.push(i);
    }
    if (matches.length !== 1) return { ok: false, message: '分割後の穴の所属先が決まりません。外周との接触や重なりを確認してください。' };
    holes[matches[0]].push(hole.curves);
  }
  return { ok: true, value: outers.map((loop, i) => ({ id: JSON.stringify(['sheet-region', id, i]), normal, outer: loop.curves, holes: holes[i] })) };
}
