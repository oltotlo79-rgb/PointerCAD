import { addScaled } from '../math/vectorArithmetic.js';
import type { Vec3Tuple } from '../types.js';
import { crossVec, dotVec, lengthVec, subVec } from './sketchCorner.js';

interface EdgeValue {
  readonly point: Vec3Tuple;
  /** Cross-edge tangent in increasing blend V, including at B. Magnitude is preserved. */
  readonly tangent: Vec3Tuple;
  /** Original face at the edge pcurve, in world coordinates. */
  readonly support?: { readonly point: Vec3Tuple; readonly normal: Vec3Tuple };
}

export interface BlendSurfaceInput {
  /** Common increasing U domain. Each evaluator maps it to its own source edge. */
  readonly uKnots: readonly number[];
  readonly edgeA: (u: number) => EdgeValue;
  readonly edgeB: (u: number) => EdgeValue;
  readonly weightA: number;
  readonly weightB: number;
  /** Reverse the U correspondence of B. Its cross-edge tangent still points in increasing V. */
  readonly flipB: boolean;
}

export interface BlendTolerance {
  readonly distanceMm: number;
  readonly angleDeg: number;
}

function checkKnots(knots: readonly number[]): void {
  if (knots.length < 2 || !Number.isFinite(knots[knots.length - 1] - knots[0])) throw new RangeError('uKnots');
  for (let i = 1; i < knots.length; i++) {
    if (!(knots[i] > knots[i - 1])) throw new RangeError('uKnots');
  }
}

function edgeValue(input: BlendSurfaceInput, u: number, side: 0 | 1): EdgeValue {
  if (side === 0) return input.edgeA(u);
  const first = input.uKnots[0], last = input.uKnots[input.uKnots.length - 1];
  const fromFirst = u - first, fromLast = last - u;
  const reflected = fromFirst <= fromLast ? last - fromFirst : first + fromLast;
  return input.edgeB(input.flipB ? reflected : u);
}

function finitePoint(point: Vec3Tuple): Vec3Tuple {
  if (!(Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]))) {
    throw new RangeError('blend coordinates');
  }
  return point;
}

function offsetPole(edge: EdgeValue, signedThird: number): Vec3Tuple {
  finitePoint(edge.point);
  if (lengthVec(finitePoint(edge.tangent)) === 0) throw new RangeError('blend tangent');
  return finitePoint(addScaled(edge.point, edge.tangent, signedThird));
}

/** Interpolate the nodes with a cubic Hermite spline. The slope at each node is the secant
 * through its two neighbours (one-sided at either end). Double interior knots share that slope.
 * For each span retain the two inner Bezier poles. The end poles clamp the whole B-spline.
 */
function fitRow(knots: readonly number[], nodes: readonly Vec3Tuple[]): Vec3Tuple[] {
  const last = nodes.length - 1;
  const inner = (i: number, span: number): Vec3Tuple => {
    const left = Math.max(0, i - 1), right = Math.min(last, i + 1);
    const factor = span / (knots[right] - knots[left]) / 3;
    return finitePoint(addScaled(nodes[i], subVec(nodes[right], nodes[left]), factor));
  };
  const poles = [nodes[0]];
  for (let i = 0; i < last; i++) {
    const span = knots[i + 1] - knots[i];
    poles.push(inner(i, span), inner(i + 1, -span));
  }
  poles.push(nodes[last]);
  return poles;
}

/** Four rows in increasing V, each indexed by U pole. The same linear U fit is applied
 * to each row, so the boundary derivatives are the fitted fields weightA*T1 and weightB*T2.
 */
export function blendControlRows(input: BlendSurfaceInput): readonly (readonly Vec3Tuple[])[] {
  checkKnots(input.uKnots);
  for (const weight of [input.weightA, input.weightB]) {
    if (!Number.isFinite(weight) || weight <= 0) throw new RangeError('blend weight');
  }
  const rows: Vec3Tuple[][] = [[], [], [], []];
  for (const u of input.uKnots) {
    const a = edgeValue(input, u, 0), b = edgeValue(input, u, 1);
    rows[0].push(a.point);
    rows[1].push(offsetPole(a, input.weightA / 3));
    rows[2].push(offsetPole(b, -input.weightB / 3));
    rows[3].push(b.point);
  }
  return rows.map(row => fitRow(input.uKnots, row));
}

function direction(vector: Vec3Tuple): Vec3Tuple | null {
  const [x, y, z] = vector;
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  return [x / scale, y / scale, z / scale];
}

interface SurfaceValue extends EdgeValue {
  readonly alongU: Vec3Tuple;
}

function angleDeg(expected: EdgeValue, actual: SurfaceValue): number {
  const source = direction(expected.tangent), across = direction(actual.tangent), along = direction(actual.alongU);
  if (!source || !across || !along) return Infinity;
  const normal = direction(crossVec(along, across));
  if (!normal) return Infinity;
  const acrossAngle = Math.atan2(lengthVec(crossVec(source, across)), dotVec(source, across));
  if (!expected.support) return acrossAngle * (180 / Math.PI);
  const original = direction(expected.support.normal);
  if (!original) return Infinity;
  // G1 compares unoriented planes. A correct dV alone can hide a tilted dU.
  const planeAngle = Math.atan2(lengthVec(crossVec(original, normal)), Math.abs(dotVec(original, normal)));
  return Math.max(acrossAngle, planeAngle) * (180 / Math.PI);
}

/** Sample the original edges and the built surface at matching parameters. Include every knot and
 * the three quarter-span points between knots. Maxima describe these samples only.
 */
export function measureBlend(input: BlendSurfaceInput, tolerance: BlendTolerance,
  surfaceAt: (u: number, side: 0 | 1) => SurfaceValue) {
  checkKnots(input.uKnots);
  const { distanceMm, angleDeg: limitDeg } = tolerance;
  if (!Number.isFinite(distanceMm) || distanceMm < 0 || !Number.isFinite(limitDeg) || limitDeg < 0 || limitDeg > 180) {
    throw new RangeError('blend tolerance');
  }
  let maxDistanceMm = 0, maxAngleDeg = 0;
  const measure = (u: number, side: 0 | 1): void => {
    const expected = edgeValue(input, u, side), actual = surfaceAt(u, side);
    const distance = lengthVec(subVec(finitePoint(actual.point), finitePoint(expected.point)));
    const faceDistance = expected.support ? lengthVec(subVec(actual.point, finitePoint(expected.support.point))) : 0;
    maxDistanceMm = Math.max(maxDistanceMm, distance, faceDistance);
    maxAngleDeg = Math.max(maxAngleDeg, angleDeg(expected, actual));
  };
  for (const side of [0, 1] as const) {
    measure(input.uKnots[0], side);
    for (let i = 1; i < input.uKnots.length; i++) {
      const left = input.uKnots[i - 1], right = input.uKnots[i];
      for (const fraction of [0.25, 0.5, 0.75]) measure(left + (right - left) * fraction, side);
      measure(right, side);
    }
  }
  return { maxDistanceMm, maxAngleDeg, withinTolerance: maxDistanceMm <= distanceMm && maxAngleDeg <= limitDeg };
}
