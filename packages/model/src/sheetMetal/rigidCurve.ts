/** 厳密な曲線を直交座標系間で剛体移動する。近似折線化や拡縮を行わない。 */
import type { ResolvedCurve } from '../sketch/types.js';
import { addVec3, dotVec3, scaleVec3, subVec3, type Vec3 } from '../sketch/vec3.js';
import type { SheetTangentFrame } from './panelGeometry.js';

export function frameDirection(vector: Vec3, source: SheetTangentFrame, target: SheetTangentFrame): Vec3 {
  return addVec3(addVec3(scaleVec3(target.xAxis, dotVec3(vector, source.xAxis)),
    scaleVec3(target.yAxis, dotVec3(vector, source.yAxis))), scaleVec3(target.normal, dotVec3(vector, source.normal)));
}
export function framePoint(value: Vec3, source: SheetTangentFrame, target: SheetTangentFrame): Vec3 {
  return addVec3(target.origin, frameDirection(subVec3(value, source.origin), source, target));
}
export function rigidSheetCurve(curve: ResolvedCurve, source: SheetTangentFrame, target: SheetTangentFrame): ResolvedCurve {
  const point = (value: Vec3) => framePoint(value, source, target);
  const direction = (value: Vec3) => frameDirection(value, source, target);
  switch (curve.kind) {
    case 'segment': return { ...curve, from: point(curve.from), to: point(curve.to) };
    case 'arc': return { ...curve, center: point(curve.center), normal: direction(curve.normal), xAxis: direction(curve.xAxis) };
    case 'ellipse': return { ...curve, center: point(curve.center), normal: direction(curve.normal), majorAxis: direction(curve.majorAxis) };
    case 'spline': return { ...curve, points: curve.points.map(point) };
  }
}
