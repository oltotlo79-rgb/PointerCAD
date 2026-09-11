/** 曲げ中心線を実際の帯の材料へ切り詰める。穴とリリーフの空間には線を出さない。 */
import { curveEnd, curveStart } from '../sketch/intersectionMath.js';
import { addVec3, dotVec3, normalizeVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetLoopContains } from './groupClippedPanels.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import { splitSheetCurveAtPlane } from './splitCurveAtPlane.js';
import type { SheetFlatGeometry } from './unfoldSheetBody.js';

export interface SheetFlatBendLine {
  readonly bendId: string; readonly from: Vec3; readonly to: Vec3;
  readonly angle: number; readonly radius: number; readonly direction: 'up' | 'down';
}
const EPSILON = 1e-7;
export function sheetFlatBendLines(flat: SheetFlatGeometry): SheetGeometryResult<readonly SheetFlatBendLine[]> {
  const lines: SheetFlatBendLine[] = [];
  for (const bend of flat.bends) {
    if (bend.panel === null || bend.angle === 0) continue;
    const length = Math.hypot(...subVec3(bend.to, bend.from));
    if (!Number.isFinite(length) || length <= EPSILON) return { ok: false, message: '曲げ中心線の長さが不正です。' };
    const ray = normalizeVec3(subVec3(bend.to, bend.from)), up: Vec3 = [-ray[1], ray[0], 0];
    const cuts = [0, length], allLoops = [bend.panel.outer, ...bend.panel.holes];
    for (const loop of allLoops) for (const curve of loop) {
      const split = splitSheetCurveAtPlane(curve, { origin: bend.from, normal: up }); if (!split.ok) return split;
      for (const piece of split.value) for (const point of [curveStart(piece.curve), curveEnd(piece.curve)]) {
        const relative = subVec3(point, bend.from), offset = dotVec3(relative, ray);
        if (Math.abs(dotVec3(relative, up)) <= EPSILON && offset > EPSILON && offset < length - EPSILON) cuts.push(offset);
      }
    }
    cuts.sort((a, b) => a - b);
    const unique = cuts.filter((value, i) => i === 0 || value - cuts[i - 1] > EPSILON);
    for (let i = 1; i < unique.length; i++) {
      const start = unique[i - 1], end = unique[i], midpoint = addVec3(bend.from, scaleVec3(ray, (start + end) / 2));
      const inside = sheetLoopContains(bend.panel.outer, midpoint, ray, up); if (!inside.ok) return inside;
      if (!inside.value) continue;
      let isHole = false;
      for (const hole of bend.panel.holes) {
        const contains = sheetLoopContains(hole, midpoint, ray, up); if (!contains.ok) return contains;
        if (contains.value) { isHole = true; break; }
      }
      if (!isHole) lines.push({ bendId: bend.id, from: addVec3(bend.from, scaleVec3(ray, start)),
        to: addVec3(bend.from, scaleVec3(ray, end)), angle: bend.angle, radius: bend.radius,
        direction: bend.angle > 0 ? 'up' : 'down' });
    }
  }
  return { ok: true, value: lines };
}
