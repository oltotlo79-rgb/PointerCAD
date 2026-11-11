/** CAD wires need a topological edge at each certified corner, including C0 B-spline knots. */
import type { CurveSpec, Vec3Tuple } from '../types.js';

function same(a: Vec3Tuple, b: Vec3Tuple): boolean { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

/**
 * A smooth function curve is C1 in its parameter. Where a node tangent was reduced to zero (both neighbouring
 * poles equal the node) it may have a geometric corner, so the edge is split there like a polyline corner.
 */
function* smoothPieces(curve: CurveSpec & { readonly kind: 'spline' }): Generator<CurveSpec> {
  const knots = curve.knots;
  if (curve.mode !== 'control' || curve.closed || knots === undefined || knots.length < 2
    || curve.points.length !== 2 * knots.length || curve.points.length > 200_000) {
    throw new Error('関数の滑らかな曲線の節点・制御点を確認してください。');
  }
  for (const point of curve.points) {
    if (point.length !== 3 || ![point[0], point[1], point[2]].every(Number.isFinite)) throw new Error('関数の滑らかな曲線には有限なXYZ座標が必要です。');
  }
  let start = 0;
  for (let node = 1; node < knots.length; node++) {
    const last = node === knots.length - 1;
    if (!last && !same(curve.points[2 * node], curve.points[2 * node + 1])) continue;
    // Node `start` begins the piece with its on-curve point; inner poles are copied unchanged.
    const points: Vec3Tuple[] = [start === 0 ? curve.points[0] : curve.points[2 * start + 1]];
    for (let pole = 2 * start + 1; pole <= 2 * node; pole++) points.push(curve.points[pole]);
    points.push(last ? curve.points[2 * node + 1] : curve.points[2 * node]);
    yield { kind: 'spline', mode: 'control', closed: false, degree: 3, knots: knots.slice(start, node + 1), points };
    start = node;
  }
}

export function* continuousCurvePieces(curves: readonly CurveSpec[]): Generator<CurveSpec> {
  for (const curve of curves) {
    if (curve.kind === 'spline' && (curve.degree === 3 || curve.knots !== undefined)) {
      if (curve.degree !== 3) throw new Error('関数の滑らかな曲線の次数を確認してください。');
      yield* smoothPieces(curve);
      continue;
    }
    if (curve.kind !== 'spline' || curve.degree !== 1) { yield curve; continue; }
    if (curve.mode !== 'control' || curve.points.length < (curve.closed ? 3 : 2) || curve.points.length > 200_000) {
      throw new Error('関数の折れ線の点数・方式を確認してください。');
    }
    for (const point of curve.points) {
      if (point.length !== 3 || ![point[0], point[1], point[2]].every(Number.isFinite)) throw new Error('関数の折れ線には有限なXYZ座標が必要です。');
    }
    for (let index = 1; index < curve.points.length; index++) {
      const from = curve.points[index - 1], to = curve.points[index];
      if (!same(from, to)) yield { kind: 'segment', from, to };
    }
    const first = curve.points[0], last = curve.points[curve.points.length - 1];
    if (curve.closed && !same(last, first)) yield { kind: 'segment', from: last, to: first };
  }
}
