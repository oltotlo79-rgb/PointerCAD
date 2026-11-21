/** 面の穴の内外は板金と同じ曲線の巻数で判定し、近似の折れ線を保存しない。 */
import { belowMagnitude, exceedsMagnitude } from '../numericTolerance.js';
import { sheetLoopContains } from '../sheetMetal/groupClippedPanels.js';
import { curveSamplePoints } from './curvePlaneSamples.js';
import { curveEnd, curveIntersections, curveParameterNear, curvePointAt, curveStart } from './intersectionMath.js';
import type { ResolvedCurve, SketchError } from './types.js';
import { crossVec3, distanceVec3, dotVec3, normalizeVec3, subVec3, type Vec3 } from './vec3.js';

const TOLERANCE_MM = 1e-7;
type HoleError = Pick<SketchError, 'code' | 'message'>;

function loopsTouch(first: readonly ResolvedCurve[], second: readonly ResolvedCurve[]): boolean {
  return first.some(a => second.some(b => curvesTouch(a, b)));
}

/** トリム用の交差関数は接線の接触を除くため、端点と円の最短点も別に確かめる。 */
function curvesTouch(first: ResolvedCurve, second: ResolvedCurve): boolean {
  const nearest = (curve: ResolvedCurve, point: Vec3) => curvePointAt(curve, curveParameterNear(curve, point));
  const candidates = [curveStart(first), curveEnd(first), curveStart(second), curveEnd(second),
    ...curveIntersections(first, second).map(hit => hit.point)];
  if (first.kind === 'arc') candidates.push(nearest(second, first.center));
  if (second.kind === 'arc') candidates.push(nearest(first, second.center));
  return candidates.some(point => distanceVec3(nearest(first, point), nearest(second, point)) <= TOLERANCE_MM);
}

function contains(loop: readonly ResolvedCurve[], point: Vec3, normal: Vec3): boolean | null {
  const helper: Vec3 = belowMagnitude(normal[0], 0.9) ? [1, 0, 0] : [0, 1, 0];
  const ray = normalizeVec3(crossVec3(normal, helper)), up = crossVec3(normal, ray);
  const result = sheetLoopContains(loop, point, ray, up);
  return result.ok ? result.value : null;
}

function holePairError(first: readonly ResolvedCurve[], second: readonly ResolvedCurve[], normal: Vec3, label: string): HoleError | null {
  if (loopsTouch(first, second)) return { code: 'invalidValue', message: `${label}が別の穴に接するか交差しています。輪郭を離してください。` };
  const forward = contains(first, curveStart(second[0]), normal), backward = contains(second, curveStart(first[0]), normal);
  if (forward === null || backward === null) return { code: 'invalidValue', message: `${label}と別の穴の内外を判定できません。輪郭を確認してください。` };
  return forward || backward ? { code: 'invalidValue', message: `${label}が別の穴と重なっています。穴を入れ子にしないでください。` } : null;
}

/** 閉じた各輪を解決した後に、外周との平面・接触・包含と穴どうしの重なりを確かめる。 */
export function faceHolesError(outer: readonly ResolvedCurve[], holes: readonly (readonly ResolvedCurve[])[], normal: Vec3 | null): HoleError | null {
  if (normal === null) return { code: 'notPlanar', message: '穴を置く外周の平面が決まりません。' };
  const origin = curveStart(outer[0]);
  for (const [index, hole] of holes.entries()) {
    const label = `穴${String(index + 1)}`;
    if (hole.flatMap(curveSamplePoints).some(point => exceedsMagnitude(dotVec3(subVec3(point, origin), normal), TOLERANCE_MM))) {
      return { code: 'notPlanar', message: `${label}が外周と同じ平面にありません。` };
    }
    if (loopsTouch(outer, hole)) return { code: 'invalidValue', message: `${label}が外周に接するか交差しています。輪郭を離してください。` };
    const inside = contains(outer, curveStart(hole[0]), normal);
    if (inside === null) return { code: 'invalidValue', message: `${label}が外周の内側にあるか判定できません。輪郭を確認してください。` };
    if (!inside) return { code: 'invalidValue', message: `${label}が外周の外にはみ出しています。` };
    for (const previous of holes.slice(0, index)) {
      const problem = holePairError(previous, hole, normal, label);
      if (problem !== null) return problem;
    }
  }
  return null;
}
