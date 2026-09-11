/** 矩形・長穴の境界と元輪郭の交点を、双方の曲線パラメータとして返す。 */
import { curveEnd, curvePointAt, curveStart } from '../sketch/intersectionMath.js';
import type { ResolvedArc, ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import { crossVec3, distanceVec3, dotVec3, lengthVec3, normalizeVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import { sheetCurveCircleCuts } from './circleCurveCuts.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import { splitSheetCurveAtPlane } from './splitCurveAtPlane.js';

export type ReliefBoundary = ResolvedSegment | ResolvedArc;
export interface ReliefIntersection { readonly source: number; readonly tool: number }
const TOLERANCE = 1e-7;

export function reliefBoundaryParameter(curve: ReliefBoundary, point: Vec3): number | null {
  if (curve.kind === 'segment') {
    const delta = subVec3(curve.to, curve.from), length = lengthVec3(delta), relative = subVec3(point, curve.from);
    if (length <= TOLERANCE || lengthVec3(crossVec3(relative, delta)) / length > TOLERANCE) return null;
    const at = dotVec3(relative, delta) / (length * length);
    return at < -TOLERANCE / length || at > 1 + TOLERANCE / length ? null : Math.max(0, Math.min(1, at));
  }
  const offset = subVec3(point, curve.center), sweep = curve.endAngle - curve.startAngle;
  if (Math.abs(lengthVec3(offset) - curve.radius) > TOLERANCE || Math.abs(dotVec3(offset, curve.normal)) > TOLERANCE) return null;
  if (distanceVec3(point, curveStart(curve)) <= TOLERANCE) return 0;
  if (distanceVec3(point, curveEnd(curve)) <= TOLERANCE) return 1;
  const angle = Math.atan2(dotVec3(offset, crossVec3(curve.normal, curve.xAxis)), dotVec3(offset, curve.xAxis));
  const delta = ((angle - curve.startAngle) * Math.sign(sweep) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const at = delta / Math.abs(sweep);
  return at <= 1 + TOLERANCE / (curve.radius * Math.abs(sweep)) ? Math.min(1, at) : null;
}

export function reliefIntersections(source: ResolvedCurve, tool: ReliefBoundary, normal: Vec3): SheetGeometryResult<readonly ReliefIntersection[]> {
  let candidates: readonly number[];
  if (tool.kind === 'arc') {
    const cuts = sheetCurveCircleCuts(source, tool.center, tool.radius, normal); if (!cuts.ok) return cuts;
    candidates = cuts.value;
  } else {
    const axis = normalizeVec3(subVec3(tool.to, tool.from));
    const cuts = splitSheetCurveAtPlane(source, { origin: tool.from, normal: crossVec3(normal, axis) }); if (!cuts.ok) return cuts;
    const parameters = cuts.value.flatMap((piece) => [piece.from, piece.to]);
    if (cuts.value.every((piece) => piece.side === 0)) {
      // 共線の区間は、工具の端でも分ける。接しているだけの境界を削らない。
      for (const point of [tool.from, tool.to]) {
        const endpoint = splitSheetCurveAtPlane(source, { origin: point, normal: axis }); if (!endpoint.ok) return endpoint;
        parameters.push(...endpoint.value.flatMap((piece) => [piece.from, piece.to]));
      }
    }
    candidates = parameters;
  }
  const result: ReliefIntersection[] = [];
  for (const at of candidates) {
    const parameter = reliefBoundaryParameter(tool, curvePointAt(source, at));
    if (parameter !== null) result.push({ source: at, tool: parameter });
  }
  return { ok: true, value: result };
}
