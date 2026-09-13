/** CAD wires need a topological edge at each certified corner, including C0 B-spline knots. */
import type { CurveSpec, Vec3Tuple } from '../types.js';

function same(a: Vec3Tuple, b: Vec3Tuple): boolean { return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]; }

export function* continuousCurvePieces(curves: readonly CurveSpec[]): Generator<CurveSpec> {
  for (const curve of curves) {
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
