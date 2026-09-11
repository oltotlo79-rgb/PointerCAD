/** 展開後の円形の内周から穴表を作る。折曲げ面の元座標を流用しない。 */
import { isValidHoleScheduleFrame, labelHoleScheduleRows, type HoleScheduleCandidate, type HoleScheduleFrame, type HoleScheduleResult } from '../drawing/holeSchedule.js';
import { distanceVec3, dotVec3, subVec3 } from '../sketch/vec3.js';
import type { SheetFlatOutline } from './flatOutline.js';

export function buildSheetFlatHoleSchedule(outline: SheetFlatOutline, frame: HoleScheduleFrame): HoleScheduleResult {
  if (!isValidHoleScheduleFrame(frame) || Math.abs(frame.x[2]) > 1e-10 || Math.abs(frame.y[2]) > 1e-10) return { ok: false, reason: 'invalidFrame' };
  const rows: HoleScheduleCandidate[] = [];
  for (const loop of outline.loops) {
    if (loop.kind !== 'hole' || loop.curves.length === 0) continue;
    const first = loop.curves[0]; if (first.kind !== 'arc') continue;
    let turn = 0, circle = true;
    for (const curve of loop.curves) {
      if (curve.kind !== 'arc' || distanceVec3(curve.center, first.center) > 1e-7 || Math.abs(curve.radius - first.radius) > 1e-7) { circle = false; break; }
      turn += Math.abs(curve.endAngle - curve.startAngle);
    }
    if (!circle || Math.abs(turn - 2 * Math.PI) > 1e-9) continue;
    const center = first.center, delta = subVec3(center, frame.datum), x = dotVec3(delta, frame.x), y = dotVec3(delta, frame.y);
    const diameter = first.radius * 2;
    if (![...center, x, y, diameter].every(Number.isFinite) || diameter <= 0) return { ok: false, reason: 'invalidValue' };
    rows.push({ id: JSON.stringify(['sheet-hole', center, diameter]), center, x: x === 0 ? 0 : x, y: y === 0 ? 0 : y,
      diameter, depth: null, featureIds: [...new Set(loop.curves.map((curve) => curve.featureId))] });
  }
  return labelHoleScheduleRows(rows);
}
