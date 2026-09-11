/** 選択境界の始端・幅・総深さから、外側へ抜ける矩形/半円先端の工具輪郭を作る。 */
import { addVec3, crossVec3, distanceVec3, dotVec3, lengthVec3, normalizeVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import type { SheetGeometryResult } from './panelGeometry.js';
import type { ReliefBoundary } from './reliefIntersections.js';

export function sheetReliefProfile(edge: { readonly from: Vec3; readonly to: Vec3 }, normal: Vec3,
  position: number, width: number, depth: number, shape: 'rectangle' | 'slot', featureId: string): SheetGeometryResult<readonly ReliefBoundary[]> {
  const length = distanceVec3(edge.from, edge.to);
  if (![length, position, width, depth, ...normal].every(Number.isFinite) || Math.min(length, width, depth) <= 1e-7 || position < 0 || position > length
    || Math.abs(lengthVec3(normal) - 1) > 1e-10 || Math.abs(dotVec3(subVec3(edge.to, edge.from), normal)) > 1e-7)
    return { ok: false, message: '切欠きの中心は縁の上に置き、幅と深さは正の長さで指定してください。' };
  if (shape === 'slot' && depth < width / 2)
    return { ok: false, message: '長穴の深さは、先端の半径（幅の半分）以上にしてください。' };
  const x = normalizeVec3(subVec3(edge.to, edge.from)), y = crossVec3(normal, x), origin = addVec3(edge.from, scaleVec3(x, position));
  const point = (a: number, b: number): Vec3 => addVec3(origin, addVec3(scaleVec3(x, a), scaleVec3(y, b)));
  const radius = width / 2, top = shape === 'slot' ? depth - radius : depth;
  const left = point(-radius, -depth), right = point(radius, -depth), topRight = point(radius, top), topLeft = point(-radius, top);
  return { ok: true, value: [
    { kind: 'segment', featureId: `${featureId}:entry`, from: left, to: right },
    { kind: 'segment', featureId: `${featureId}:right`, from: right, to: topRight },
    shape === 'slot' ? { kind: 'arc', featureId: `${featureId}:tip`, center: point(0, top), radius, normal, xAxis: x, startAngle: 0, endAngle: Math.PI }
      : { kind: 'segment', featureId: `${featureId}:tip`, from: topRight, to: topLeft },
    { kind: 'segment', featureId: `${featureId}:left`, from: topLeft, to: left },
  ] };
}
