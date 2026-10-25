/**
 * Order of the corner points of a face made from selected points (R30, FR-309/FR-330).
 *
 * The same tolerance as the face boundary resolver (`SKETCH_TOLERANCE_MM`) decides whether
 * two points coincide, whether the points lie on one plane (`fitPlaneNormal` / `isPlanar`),
 * and whether a corner touches another edge. No separate tolerance is introduced here.
 */
import { dotVec3, fitPlaneNormal, isPlanar, isSamePoint, planeAxesFor, SKETCH_TOLERANCE_MM, subVec3,
  type Vec3 } from '@pointercad/model';

export type FacePointOrderRefusal = 'samePoint' | 'collinear' | 'notPlanar' | 'selfIntersecting';

export type FacePointOrder =
  | { readonly ok: true; readonly order: readonly number[]; readonly reordered: boolean }
  | { readonly ok: false; readonly reason: FacePointOrderRefusal };

type Flat = readonly [number, number];

/** The smallest number of points that encloses an area. */
export const MIN_FACE_CORNERS = 3;

function cross(a: Flat, b: Flat, c: Flat): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointSegmentDistance(point: Flat, from: Flat, to: Flat): number {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared === 0 ? 0
    : Math.min(1, Math.max(0, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (from[0] + ratio * dx), point[1] - (from[1] + ratio * dy));
}

function opposite(first: number, second: number): boolean {
  return (first > 0 && second < 0) || (first < 0 && second > 0);
}

/** Two edges cross, or one end comes within the tolerance of the other edge. */
function edgesTouch(a: Flat, b: Flat, c: Flat, d: Flat): boolean {
  if (opposite(cross(a, b, c), cross(a, b, d)) && opposite(cross(c, d, a), cross(c, d, b))) return true;
  return Math.min(pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
    pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d)) <= SKETCH_TOLERANCE_MM;
}

/**
 * A closed polyline is simple when no two edges meet except adjacent edges at their shared corner.
 * Adjacent edges must not fold back onto each other; a straight corner (180 degrees) is allowed.
 */
export function isSimplePolygon(points: readonly Flat[]): boolean {
  const count = points.length;
  if (count < MIN_FACE_CORNERS) return false;
  for (let i = 0; i < count; i += 1) {
    const from = points[i], to = points[(i + 1) % count], next = points[(i + 2) % count];
    if (pointSegmentDistance(next, from, to) <= SKETCH_TOLERANCE_MM
      || pointSegmentDistance(from, to, next) <= SKETCH_TOLERANCE_MM) return false;
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      if (edgesTouch(from, to, points[j], points[(j + 1) % count])) return false;
    }
  }
  return true;
}

/**
 * Keep the selection order when it encloses an area. Otherwise sort the points by the angle
 * around their centroid on the plane, starting from the first selected point, and accept that
 * order only when it is simple as well.
 */
export function orderFacePoints(positions: readonly Vec3[]): FacePointOrder {
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = i + 1; j < positions.length; j += 1) {
      if (isSamePoint(positions[i], positions[j])) return { ok: false, reason: 'samePoint' };
    }
  }
  const normal = fitPlaneNormal(positions);
  if (normal === null) return { ok: false, reason: 'collinear' };
  if (!isPlanar(positions)) return { ok: false, reason: 'notPlanar' };
  const { axisU, axisV } = planeAxesFor(normal);
  const origin = positions[0];
  const flat = positions.map((position): Flat => {
    const relative = subVec3(position, origin);
    return [dotVec3(relative, axisU), dotVec3(relative, axisV)];
  });
  const selected = flat.map((_, index) => index);
  if (isSimplePolygon(flat)) return { ok: true, order: selected, reordered: false };
  const centre: Flat = [flat.reduce((sum, point) => sum + point[0], 0) / flat.length,
    flat.reduce((sum, point) => sum + point[1], 0) / flat.length];
  const angle = (index: number): number => Math.atan2(flat[index][1] - centre[1], flat[index][0] - centre[0]);
  const distance = (index: number): number => Math.hypot(flat[index][0] - centre[0], flat[index][1] - centre[1]);
  const sorted = [...selected].sort((a, b) => angle(a) - angle(b) || distance(a) - distance(b));
  const start = sorted.indexOf(0);
  const order = [...sorted.slice(start), ...sorted.slice(0, start)];
  if (!isSimplePolygon(order.map(index => flat[index]))) return { ok: false, reason: 'selfIntersecting' };
  return { ok: true, order, reordered: true };
}
