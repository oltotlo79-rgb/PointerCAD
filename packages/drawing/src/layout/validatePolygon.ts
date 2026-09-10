import type { Point2 } from '../types.js';

/** 入力する切り抜き境界の上限。投影済みの曲線の頂点数とは分ける。 */
export const MAX_DRAWING_BOUNDARY_POINTS = 256;
const EPSILON = 1e-12;

const cross = (a: Point2, b: Point2, c: Point2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function onSegment(a: Point2, b: Point2, p: Point2): boolean {
  return Math.abs(cross(a, b, p)) <= EPSILON
    && p[0] >= Math.min(a[0], b[0]) - EPSILON && p[0] <= Math.max(a[0], b[0]) + EPSILON
    && p[1] >= Math.min(a[1], b[1]) - EPSILON && p[1] <= Math.max(a[1], b[1]) + EPSILON;
}
function intersects(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

/** 始点の再記入を含まない、単純で面積を持つ閉輪郭を要求する。凹形は許す。 */
export function validateDrawingPolygon(points: readonly Point2[]): string | null {
  if (points.length < 3 || points.length > MAX_DRAWING_BOUNDARY_POINTS) return '輪郭は3〜256点で指定してください。';
  if (points.some((point) => !point.every(Number.isFinite))) return '輪郭の座標を有限の値で指定してください。';
  const origin = points[0];
  const relative = points.map((point): Point2 => [point[0] - origin[0], point[1] - origin[1]]);
  const extent = relative.reduce((maximum, point) => Math.max(maximum, Math.abs(point[0]), Math.abs(point[1])), 0);
  if (!Number.isFinite(extent) || extent <= 1e-9) return '輪郭には広がりが必要です。';
  const normalized = relative.map((point): Point2 => [point[0] / extent, point[1] / extent]);
  let twiceArea = 0;
  for (let index = 0; index < normalized.length; index++) {
    const a = normalized[index], b = normalized[(index + 1) % normalized.length], c = normalized[(index + 2) % normalized.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= EPSILON) return '隣り合う点を離してください。始点は末尾に繰り返しません。';
    if (Math.abs(cross(a, b, c)) <= EPSILON && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) <= 0) {
      return '輪郭の辺を折り返して重ねることはできません。';
    }
    twiceArea += a[0] * b[1] - b[0] * a[1];
    for (let other = index + 2; other < normalized.length; other++) {
      if (index === 0 && other === normalized.length - 1) continue;
      if (intersects(a, b, normalized[other], normalized[(other + 1) % normalized.length])) return '輪郭の辺を交差させたり、途中で接触させたりすることはできません。';
    }
  }
  return Math.abs(twiceArea) <= EPSILON ? '輪郭には面積が必要です。' : null;
}
