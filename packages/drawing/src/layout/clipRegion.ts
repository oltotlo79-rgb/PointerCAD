import type { Point2 } from '../types.js';

export type ClipCurve =
  | { readonly kind: 'segment'; readonly from: Point2; readonly to: Point2 }
  | { readonly kind: 'arc'; readonly center: Point2; readonly radius: number; readonly startAngle: number; readonly endAngle: number }
  | { readonly kind: 'polyline'; readonly points: readonly Point2[]; readonly closed: boolean };

export type ClipRegion =
  | { readonly kind: 'circle'; readonly center: Point2; readonly radius: number }
  | { readonly kind: 'polygon'; readonly points: readonly Point2[] };

const EPSILON = 1e-9;
const TAU = 2 * Math.PI;

export function drawingRegionContainsPoint(point: Point2, region: ClipRegion): boolean {
  if (region.kind === 'circle') return Math.hypot(point[0] - region.center[0], point[1] - region.center[1]) <= region.radius + EPSILON;
  let inside = false;
  for (let i = 0, j = region.points.length - 1; i < region.points.length; j = i, i += 1) {
    const a = region.points[i]; const b = region.points[j];
    if (a === undefined || b === undefined) continue;
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const cross = (point[0] - a[0]) * dy - (point[1] - a[1]) * dx;
    if (Math.abs(cross) <= EPSILON * Math.max(1, Math.hypot(dx, dy))
        && point[0] >= Math.min(a[0], b[0]) - EPSILON && point[0] <= Math.max(a[0], b[0]) + EPSILON
        && point[1] >= Math.min(a[1], b[1]) - EPSILON && point[1] <= Math.max(a[1], b[1]) + EPSILON) return true;
    if (((a[1] > point[1]) !== (b[1] > point[1])) &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const pointInside = drawingRegionContainsPoint;

function segmentIntersectionParameters(from: Point2, to: Point2, region: ClipRegion): number[] {
  const dx = to[0] - from[0]; const dy = to[1] - from[1];
  if (region.kind === 'circle') {
    const ox = from[0] - region.center[0]; const oy = from[1] - region.center[1];
    const a = dx * dx + dy * dy; if (a <= EPSILON) return [];
    const b = 2 * (ox * dx + oy * dy); const c = ox * ox + oy * oy - region.radius * region.radius;
    const discriminant = b * b - 4 * a * c; if (discriminant < -EPSILON) return [];
    const root = Math.sqrt(Math.max(0, discriminant));
    return [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((t) => t > EPSILON && t < 1 - EPSILON);
  }
  const result: number[] = [];
  for (let index = 0; index < region.points.length; index += 1) {
    const a = region.points[index]; const b = region.points[(index + 1) % region.points.length];
    if (a === undefined || b === undefined) continue;
    const ex = b[0] - a[0]; const ey = b[1] - a[1];
    const denominator = dx * ey - dy * ex; if (Math.abs(denominator) <= EPSILON) continue;
    const qx = a[0] - from[0]; const qy = a[1] - from[1];
    const t = (qx * ey - qy * ex) / denominator; const u = (qx * dy - qy * dx) / denominator;
    if (t > EPSILON && t < 1 - EPSILON && u >= -EPSILON && u <= 1 + EPSILON) result.push(t);
  }
  return result;
}

function clipSegment(from: Point2, to: Point2, region: ClipRegion): ClipCurve[] {
  const cuts = [0, ...segmentIntersectionParameters(from, to, region), 1].sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || Math.abs(value - (all[index - 1] ?? value)) > EPSILON);
  const result: ClipCurve[] = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const a = cuts[index]; const b = cuts[index + 1]; if (a === undefined || b === undefined) continue;
    const at = (t: number): Point2 => [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    if (pointInside(at((a + b) / 2), region)) result.push({ kind: 'segment', from: at(a), to: at(b) });
  }
  return result;
}

function angleFraction(angle: number, start: number, sweep: number): number {
  const sign = sweep >= 0 ? 1 : -1;
  const delta = ((sign * (angle - start % TAU)) % TAU + TAU) % TAU;
  return delta / Math.abs(sweep);
}

function arcBoundaryAngles(curve: Extract<ClipCurve, { kind: 'arc' }>, region: ClipRegion): number[] {
  const points: Point2[] = [];
  if (region.kind === 'circle') {
    const dx = region.center[0] - curve.center[0]; const dy = region.center[1] - curve.center[1];
    const d = Math.hypot(dx, dy);
    if (d > EPSILON && d <= curve.radius + region.radius + EPSILON && d >= Math.abs(curve.radius - region.radius) - EPSILON) {
      const along = (curve.radius ** 2 - region.radius ** 2 + d ** 2) / (2 * d);
      const height = Math.sqrt(Math.max(0, curve.radius ** 2 - along ** 2));
      const x = curve.center[0] + along * dx / d; const y = curve.center[1] + along * dy / d;
      points.push([x - height * dy / d, y + height * dx / d], [x + height * dy / d, y - height * dx / d]);
    }
  } else {
    for (let index = 0; index < region.points.length; index += 1) {
      const a = region.points[index]; const b = region.points[(index + 1) % region.points.length];
      if (a === undefined || b === undefined) continue;
      if (Math.abs(Math.hypot(a[0] - curve.center[0], a[1] - curve.center[1]) - curve.radius) <= EPSILON) points.push(a);
      for (const t of segmentIntersectionParameters(a, b, { kind: 'circle', center: curve.center, radius: curve.radius })) {
        points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return points.map((point) => Math.atan2(point[1] - curve.center[1], point[0] - curve.center[0]));
}

function clipArc(curve: Extract<ClipCurve, { kind: 'arc' }>, region: ClipRegion): ClipCurve[] {
  const sweep = curve.endAngle - curve.startAngle; if (Math.abs(sweep) <= EPSILON) return [];
  const cuts = [0, ...arcBoundaryAngles(curve, region).map((angle) => angleFraction(angle, curve.startAngle, sweep)), 1]
    .filter((value) => value >= 0 && value <= 1).sort((a, b) => a - b)
    .filter((value, index, all) => index === 0 || Math.abs(value - (all[index - 1] ?? value)) > EPSILON);
  const result: ClipCurve[] = [];
  for (let index = 0; index + 1 < cuts.length; index += 1) {
    const a = cuts[index]; const b = cuts[index + 1]; if (a === undefined || b === undefined) continue;
    const middle = curve.startAngle + sweep * (a + b) / 2;
    const point: Point2 = [curve.center[0] + curve.radius * Math.cos(middle), curve.center[1] + curve.radius * Math.sin(middle)];
    if (pointInside(point, region)) result.push({ ...curve, startAngle: curve.startAngle + sweep * a, endAngle: curve.startAngle + sweep * b });
  }
  return result;
}

export function clipCurves(curves: readonly ClipCurve[], region: ClipRegion): readonly ClipCurve[] {
  if ((region.kind === 'circle' && !(region.radius > 0)) || (region.kind === 'polygon' && region.points.length < 3)) return [];
  return curves.flatMap((curve): readonly ClipCurve[] => {
    if (curve.kind === 'segment') return clipSegment(curve.from, curve.to, region);
    if (curve.kind === 'arc') return clipArc(curve, region);
    const points = curve.closed ? [...curve.points, curve.points[0]] : curve.points;
    const segments = points.slice(0, -1).flatMap((point, index) => {
      const next = points[index + 1]; return point === undefined || next === undefined ? [] : clipSegment(point, next, region);
    });
    return segments;
  });
}

export function regionContainsAnyCurvePoint(curves: readonly ClipCurve[], region: ClipRegion): boolean {
  return curves.some((curve) => curve.kind === 'segment' ? pointInside(curve.from, region) || pointInside(curve.to, region)
    : curve.kind === 'polyline' ? curve.points.some((point) => pointInside(point, region))
      : pointInside([curve.center[0] + curve.radius * Math.cos(curve.startAngle), curve.center[1] + curve.radius * Math.sin(curve.startAngle)], region));
}
