import type { AffineTransform2, RenderSubpath } from './types.js';
import type { Point2 } from '../types.js';

export interface FlattenedRenderPath {
  readonly points: readonly Point2[];
  readonly closed: boolean;
  readonly curved: boolean;
}
const identity: AffineTransform2 = [1, 0, 0, 1, 0, 0];
const same = (a: Point2, b: Point2): boolean => a[0] === b[0] && a[1] === b[1];
const midpoint = (a: Point2, b: Point2): Point2 => [a[0] / 2 + b[0] / 2, a[1] / 2 + b[1] / 2];

function distanceToChord(point: Point2, from: Point2, to: Point2): number {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - from[0], point[1] - from[1]);
  const along = Math.max(0, Math.min(length, (point[0] - from[0]) * dx / length + (point[1] - from[1]) * dy / length));
  return Math.hypot(point[0] - from[0] - along * dx / length, point[1] - from[1] - along * dy / length);
}

/** 変換後の紙面で誤差を抑える。モデル座標のscale倍に対してε/scaleで分けることと同値。 */
export function flattenRenderPath(path: RenderSubpath, toleranceMm = 0.001,
  transform: AffineTransform2 = identity): FlattenedRenderPath | null {
  if (!Number.isFinite(toleranceMm) || toleranceMm <= 0 || !transform.every(Number.isFinite)) return null;
  const project = (point: Point2): Point2 => [transform[0] * point[0] + transform[2] * point[1] + transform[4],
    transform[1] * point[0] + transform[3] * point[1] + transform[5]];
  const first = path.commands[0];
  if (first?.kind !== 'M') return null;
  const origin = project(first.to);
  if (!origin.every(Number.isFinite)) return null;
  const points: Point2[] = [origin];
  let current = origin, closed = false, curved = false;
  const cubic = (a: Point2, b: Point2, c: Point2, d: Point2, depth: number): boolean => {
    if (points.length >= 100_000) return false;
    if (Math.max(distanceToChord(b, a, d), distanceToChord(c, a, d)) <= toleranceMm) { points.push(d); return true; }
    if (depth >= 24) return false;
    const ab = midpoint(a, b), bc = midpoint(b, c), cd = midpoint(c, d);
    const abc = midpoint(ab, bc), bcd = midpoint(bc, cd), middle = midpoint(abc, bcd);
    return cubic(a, ab, abc, middle, depth + 1) && cubic(middle, bcd, cd, d, depth + 1);
  };
  for (const command of path.commands.slice(1)) {
    if (closed || command.kind === 'M') return null;
    if (command.kind === 'Z') { closed = true; continue; }
    const to = project(command.to);
    if (!to.every(Number.isFinite)) return null;
    if (command.kind === 'C') {
      const b = project(command.control1), c = project(command.control2);
      if (![...b, ...c].every(Number.isFinite) || !cubic(current, b, c, to, 0)) return null;
      curved = true;
    } else if (!same(current, to)) {
      if (points.length >= 100_000) return null;
      points.push(to);
    }
    current = to;
  }
  if (closed && points.length > 1 && same(points[points.length - 1], origin)) points.pop();
  return { points, closed, curved };
}
