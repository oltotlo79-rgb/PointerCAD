import type { RenderSubpath } from '../render/types.js';
import type { Point2, Vector3 } from '../types.js';

export type OutlineCurve =
  | { readonly kind: 'segment'; readonly from: Vector3; readonly to: Vector3 }
  | { readonly kind: 'spline'; readonly mode: 'control'; readonly points: readonly [Vector3, Vector3, Vector3, Vector3]; readonly closed: false };

export interface OutlineContour {
  readonly curves: readonly OutlineCurve[];
  /** Greenの公式による符号付き面積。穴の向きを外周へ勝手にそろえない。 */
  readonly signedArea: number;
}

function point3(point: Point2): Vector3 { return [point[0], point[1], 0]; }
function samePoint(a: Point2, b: Point2): boolean { return a[0] === b[0] && a[1] === b[1]; }
function finite(point: Point2): boolean { return point.every(Number.isFinite); }
function relative(point: Point2, origin: Point2): Point2 { return [point[0] - origin[0], point[1] - origin[1]]; }

function coefficients(p0: number, p1: number, p2: number, p3: number): readonly number[] {
  return [p0, 3 * (p1 - p0), 3 * (p2 - 2 * p1 + p0), p3 - 3 * p2 + 3 * p1 - p0];
}

/** 3次の積を次数ごとに積分する。折れ線の面積で穴の分類を代用しない。 */
function cubicArea(p0: Point2, p1: Point2, p2: Point2, p3: Point2): number {
  const x = coefficients(p0[0], p1[0], p2[0], p3[0]);
  const y = coefficients(p0[1], p1[1], p2[1], p3[1]);
  let integral = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = 1; j < 4; j += 1) integral += (x[i] * j * y[j] - y[i] * j * x[j]) / (i + j);
  }
  return integral / 2;
}

/** 閉じた文字輪郭を線分と厳密な3次B-splineの制御点へ写す(P8-44/51)。 */
export function outlineCurves(subpaths: readonly RenderSubpath[]): readonly OutlineContour[] | null {
  const contours: OutlineContour[] = [];
  for (const subpath of subpaths) {
    const first = subpath.commands[0];
    if (first?.kind !== 'M' || !finite(first.to)) return null;
    const origin = first.to;
    let current = origin;
    let closed = false;
    let signedArea = 0;
    const curves: OutlineCurve[] = [];
    for (const command of subpath.commands.slice(1)) {
      if (closed || command.kind === 'M') return null;
      if (command.kind === 'Z') {
        if (!samePoint(current, origin)) curves.push({ kind: 'segment', from: point3(current), to: point3(origin) });
        // 面積計算は各輪の始点を原点へ移して行う。閉じ辺はその座標系で寄与0。
        closed = true;
        continue;
      }
      if (!finite(command.to)) return null;
      if (command.kind === 'L') {
        if (!samePoint(current, command.to)) curves.push({ kind: 'segment', from: point3(current), to: point3(command.to) });
        const from = relative(current, origin), to = relative(command.to, origin);
        signedArea += (from[0] * to[1] - from[1] * to[0]) / 2;
      } else {
        if (!finite(command.control1) || !finite(command.control2)) return null;
        // 4極・次数3・節点[0,1]・多重度[4,4]のclamped B-splineはBezierと同一。
        curves.push({ kind: 'spline', mode: 'control', closed: false,
          points: [point3(current), point3(command.control1), point3(command.control2), point3(command.to)] });
        signedArea += cubicArea(relative(current, origin), relative(command.control1, origin),
          relative(command.control2, origin), relative(command.to, origin));
      }
      current = command.to;
    }
    if (!closed || curves.length === 0 || !Number.isFinite(signedArea) || signedArea === 0) return null;
    contours.push({ curves, signedArea });
  }
  return contours;
}
