/** 面の穴の内外は板金と同じ曲線の巻数で判定し、近似の折れ線を保存しない。 */
import { belowMagnitude, exceedsMagnitude } from '../numericTolerance.js';
import { sheetLoopContains } from '../sheetMetal/groupClippedPanels.js';
import { curveSamplePoints } from './curvePlaneSamples.js';
import { curveEnd, curveIntersections, curveParameterNear, curvePointAt, curveStart } from './intersectionMath.js';
import type { ResolvedCurve, SketchError } from './types.js';
import { crossVec3, distanceVec3, dotVec3, normalizeVec3, subVec3, type Vec3 } from './vec3.js';

const TOLERANCE_MM = 1e-7;
const MAX_HOLE_GEOMETRY_CHECKS = 32768;
const AXES = [0, 1, 2] as const;
type Axis = (typeof AXES)[number];
type HoleError = Pick<SketchError, 'code' | 'text'>;

interface Bounds {
  readonly low: Vec3;
  readonly high: Vec3;
}

interface BoundedCurve {
  readonly curve: ResolvedCurve;
  readonly bounds: Bounds;
}

interface HoleLoop {
  readonly index: number;
  readonly curves: readonly ResolvedCurve[];
  readonly edges: readonly BoundedCurve[];
  readonly bounds: Bounds;
}

function curveBounds(curve: ResolvedCurve): Bounds {
  if (curve.kind === 'segment') {
    const { from, to } = curve;
    return {
      low: [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])],
      high: [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])],
    };
  }
  // An interpolating spline may extend outside its input points.
  if (curve.kind === 'spline') return { low: [-Infinity, -Infinity, -Infinity], high: [Infinity, Infinity, Infinity] };
  const [x, y, z] = curve.center;
  const radius = curve.kind === 'arc' ? curve.radius : Math.max(curve.majorRadius, curve.minorRadius);
  return { low: [x - radius, y - radius, z - radius], high: [x + radius, y + radius, z + radius] };
}

function boundLoop(curves: readonly ResolvedCurve[], index: number): HoleLoop {
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const edges = curves.map(curve => {
    const bounds = curveBounds(curve);
    for (const axis of AXES) {
      low[axis] = Math.min(low[axis], bounds.low[axis]);
      high[axis] = Math.max(high[axis], bounds.high[axis]);
    }
    return { curve, bounds };
  });
  return { index, curves, edges, bounds: { low, high } };
}

function boxesOverlap(first: Bounds, second: Bounds): boolean {
  return AXES.every(axis => !(first.low[axis] > second.high[axis] + TOLERANCE_MM
    || second.low[axis] > first.high[axis] + TOLERANCE_MM));
}

function lowerPrefixBound(values: readonly number[], minimum: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < minimum) left = middle + 1;
    else right = middle;
  }
  return left;
}

function earlierHoleCandidates(holes: readonly HoleLoop[], normal: Vec3): (hole: HoleLoop) => readonly HoleLoop[] {
  const tangent = AXES.filter(axis => belowMagnitude(normal[axis], 0.9));
  const width = (axis: Axis): number => {
    let low = Infinity;
    let high = -Infinity;
    for (const hole of holes) {
      if (Number.isFinite(hole.bounds.low[axis])) low = Math.min(low, hole.bounds.low[axis]);
      if (Number.isFinite(hole.bounds.high[axis])) high = Math.max(high, hole.bounds.high[axis]);
    }
    return high - low;
  };
  const axis = tangent.reduce((best, next) => width(next) > width(best) ? next : best, tangent[0]);
  const sorted = [...holes].sort((first, second) => first.bounds.low[axis] - second.bounds.low[axis]);
  let highest = -Infinity;
  const prefixMaxima = sorted.map(hole => {
    highest = Math.max(highest, hole.bounds.high[axis]);
    return highest;
  });
  return hole => {
    const first = lowerPrefixBound(prefixMaxima, hole.bounds.low[axis] - TOLERANCE_MM);
    const last = hole.bounds.high[axis] + TOLERANCE_MM;
    const candidates: HoleLoop[] = [];
    for (let position = first; position < sorted.length && sorted[position].bounds.low[axis] <= last; position += 1) {
      const previous = sorted[position];
      if (previous.index < hole.index && boxesOverlap(previous.bounds, hole.bounds)) candidates.push(previous);
    }
    return candidates.sort((first, second) => first.index - second.index);
  };
}

type SpendCheck = (count: number) => boolean;

function loopsTouch(first: HoleLoop, second: HoleLoop, spend: SpendCheck): boolean | null {
  for (const edge of first.edges) {
    for (const other of second.edges) {
      if (!boxesOverlap(edge.bounds, other.bounds)) continue;
      if (!spend(1)) return null;
      if (curvesTouch(edge.curve, other.curve)) return true;
    }
  }
  return false;
}

/** トリム用の交差関数は接線の接触を除くため、端点と円の最短点も別に確かめる。 */
export function curvesTouch(first: ResolvedCurve, second: ResolvedCurve): boolean {
  const nearest = (curve: ResolvedCurve, point: Vec3) => curvePointAt(curve, curveParameterNear(curve, point));
  const candidates = [curveStart(first), curveEnd(first), curveStart(second), curveEnd(second),
    ...curveIntersections(first, second).map(hit => hit.point)];
  if (first.kind === 'arc') candidates.push(nearest(second, first.center));
  if (second.kind === 'arc') candidates.push(nearest(first, second.center));
  return candidates.some(point => distanceVec3(nearest(first, point), nearest(second, point)) <= TOLERANCE_MM);
}

function contains(loop: HoleLoop, point: Vec3, normal: Vec3): boolean | null {
  const helper: Vec3 = belowMagnitude(normal[0], 0.9) ? [1, 0, 0] : [0, 1, 0];
  const ray = normalizeVec3(crossVec3(normal, helper)), up = crossVec3(normal, ray);
  const result = sheetLoopContains(loop.curves, point, ray, up);
  return result.ok ? result.value : null;
}

function budgetError(): HoleError {
  return { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.checkBudget', parameters: {} } };
}

function holePairError(first: HoleLoop, second: HoleLoop, normal: Vec3, label: string, spend: SpendCheck): HoleError | null {
  const touch = loopsTouch(first, second, spend);
  if (touch === null) return budgetError();
  if (touch) return { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.touchesHole', parameters: { label } } };
  if (!spend(first.curves.length + second.curves.length)) return budgetError();
  const forward = contains(first, curveStart(second.curves[0]), normal), backward = contains(second, curveStart(first.curves[0]), normal);
  if (forward === null || backward === null) return { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.holeSideUnknown', parameters: { label } } };
  return forward || backward ? { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.nested', parameters: { label } } } : null;
}

function outerError(outer: HoleLoop, hole: HoleLoop, normal: Vec3, label: string, spend: SpendCheck): HoleError | null {
  const origin = curveStart(outer.curves[0]);
  if (hole.curves.flatMap(curveSamplePoints).some(point => exceedsMagnitude(dotVec3(subVec3(point, origin), normal), TOLERANCE_MM))) {
    return { code: 'notPlanar', text: { key: 'partError.sketchFaceHole.notSamePlane', parameters: { label } } };
  }
  const touch = loopsTouch(outer, hole, spend);
  if (touch === null) return budgetError();
  if (touch) return { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.touchesOuter', parameters: { label } } };
  if (!spend(outer.curves.length)) return budgetError();
  const inside = contains(outer, curveStart(hole.curves[0]), normal);
  if (inside === null) return { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.outerSideUnknown', parameters: { label } } };
  return inside ? null : { code: 'invalidValue', text: { key: 'partError.sketchFaceHole.outsideOuter', parameters: { label } } };
}

/** 閉じた各輪を解決した後に、外周との平面・接触・包含と穴どうしの重なりを確かめる。 */
export function faceHolesError(outer: readonly ResolvedCurve[], holes: readonly (readonly ResolvedCurve[])[], normal: Vec3 | null): HoleError | null {
  if (normal === null) return { code: 'notPlanar', text: { key: 'partError.sketchFaceHole.outerPlaneUnknown', parameters: {} } };
  const boundary = boundLoop(outer, -1);
  const inside = holes.map(boundLoop);
  const candidatesFor = earlierHoleCandidates(inside, normal);
  let remaining = MAX_HOLE_GEOMETRY_CHECKS;
  const spend: SpendCheck = count => {
    remaining -= count;
    return remaining >= 0;
  };
  for (const hole of inside) {
    const label = `穴${String(hole.index + 1)}`;
    const outside = outerError(boundary, hole, normal, label, spend);
    if (outside !== null) return outside;
    for (const previous of candidatesFor(hole)) {
      const problem = holePairError(previous, hole, normal, label, spend);
      if (problem !== null) return problem;
    }
  }
  return null;
}
