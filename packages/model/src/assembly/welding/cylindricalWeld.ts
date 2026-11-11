import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { SolidBody, SolidFaceEntry } from '../../kernelBridge.js';
import { resolveSubShapeReference } from '../../kernelBridge/referenceResolution.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { applyPlacementToDirection, applyPlacementToPoint, type RigidPlacement } from '../placementMath.js';
import { WELD_DIRECTION_TOLERANCE, WELD_LENGTH_TOLERANCE_MM, type WeldFrame, type WeldSegmentSpec } from './types.js';

/** The first leg is radial on a plane; the second leg is arc length on the selected cylinder side. */
export interface CylindricalWeldSection {
  readonly angleRadians: number;
  readonly toe: readonly [number, number];
  readonly area: number;
  readonly minimumAltitude: number;
}

export type CylindricalWeldSide = 'exterior' | 'interior';

/** (theta - sin(theta)) / theta^3, avoiding cancellation for a nearly flat cylinder. */
function segmentFactor(theta: number): number {
  if (theta >= 0.1) return (theta - Math.sin(theta)) / (theta * theta * theta);
  const t = theta * theta;
  return 1 / 6 + t * (-1 / 120 + t * (1 / 5040 + t * (-1 / 362880
    + t * (1 / 39916800 + t * (-1 / 6227020800 + t / 1307674368000)))));
}

/**
 * Local cylinder center (0,-R), root (0,0), arc toe (R sin(theta),R cos(theta)-R),
 * planar toe (0,h). A circle arc and two straight sides form the exact section.
 * The toe's supporting tangent requires h cos(theta) >= R(1-cos(theta)); otherwise
 * the free side enters the parent cylinder despite both contact endpoints being valid.
 * For an inner wall the center and arc rise are reflected about the root tangent.
 * The planar toe must remain inside the opposite wall with the existing length clearance.
 * The circular segment is then added. Both sections retain the single-quadrant limit.
 */
export function cylindricalWeldSection(radius: number, arcLength: number, radialLeg: number,
  side: CylindricalWeldSide = 'exterior'): CylindricalWeldSection | null {
  if (side !== 'exterior' && side !== 'interior') return null;
  if (![radius, arcLength, radialLeg].every(value => Number.isFinite(value) && value > WELD_LENGTH_TOLERANCE_MM)) return null;
  const angleRadians = arcLength / radius;
  if (!(angleRadians > 0 && angleRadians < Math.PI / 2)) return null;
  const sine = Math.sin(angleRadians), cosine = Math.cos(angleRadians);
  const halfSine = Math.sin(angleRadians / 2);
  const drop = 2 * radius * halfSine * halfSine;
  if (side === 'exterior' ? !(radialLeg * cosine >= drop)
    : !(radialLeg / radius < 2 && radius - (radialLeg - radius) > WELD_LENGTH_TOLERANCE_MM)) return null;
  const x = arcLength * (sine / angleRadians);
  // Triangle OCP plus/minus its circular segment; arcLength^2 * theta avoids R^2 overflow.
  const circularSegmentTwice = arcLength * arcLength * angleRadians * segmentFactor(angleRadians);
  const rise = side === 'interior' ? drop : -drop;
  const area = (x * radialLeg + (side === 'interior' ? circularSegmentTwice : -circularSegmentTwice)) / 2;
  const longestSide = Math.max(arcLength, radialLeg, Math.hypot(x, radialLeg - rise));
  const minimumAltitude = 2 * area / longestSide;
  if (![x, drop, area, minimumAltitude].every(Number.isFinite) || !(area > 0)
    || minimumAltitude < WELD_LENGTH_TOLERANCE_MM) return null;
  return { angleRadians, toe: [x, rise], area, minimumAltitude };
}

export interface CurrentCylinder {
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly radius: number;
  readonly span: readonly [number, number];
  readonly normal: Vec3;
  readonly side: CylindricalWeldSide;
}

type CylinderMetadata = Pick<SolidFaceEntry, 'surfaceKind' | 'radius' | 'axis' | 'axisOrigin' | 'cylinderSpan' | 'cylinderExterior'>;

function finite3(value: Vec3): boolean {
  return value.length === 3 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

/** Part-coordinate native data -> one assembly placement. A centroid is never an axis origin. */
function cylinderAt(geometry: CylinderMetadata, placement: RigidPlacement, root: Vec3): CurrentCylinder | null {
  const { axisOrigin, axis, cylinderSpan: span, radius } = geometry;
  if (geometry.surfaceKind !== 'cylinder' || typeof geometry.cylinderExterior !== 'boolean' || axisOrigin == null || axis === null
    || radius === null || !Number.isFinite(radius) || radius <= WELD_LENGTH_TOLERANCE_MM
    || !finite3(axisOrigin) || !finite3(axis) || !finite3(root)
    || Math.abs(lengthVec3(axis) - 1) > WELD_DIRECTION_TOLERANCE || span == null || span.length !== 2
    || !Number.isFinite(span[0]) || !Number.isFinite(span[1]) || !(span[1] > span[0])) return null;
  const origin = applyPlacementToPoint(placement, axisOrigin), transformedAxis = applyPlacementToDirection(placement, axis);
  if (!finite3(origin) || !finite3(transformedAxis) || Math.abs(lengthVec3(transformedAxis) - 1) > WELD_DIRECTION_TOLERANCE) return null;
  const worldAxis = scaleVec3(transformedAxis, 1 / lengthVec3(transformedAxis));
  const offset = subVec3(root, origin), radial = subVec3(offset, scaleVec3(worldAxis, dotVec3(offset, worldAxis)));
  const distance = lengthVec3(radial);
  if (!Number.isFinite(distance) || Math.abs(distance - radius) > WELD_LENGTH_TOLERANCE_MM || !(distance > 0)) return null;
  const side = geometry.cylinderExterior ? 'exterior' : 'interior';
  return { origin, axis: worldAxis, radius, span, side,
    normal: scaleVec3(radial, (side === 'interior' ? -1 : 1) / distance) };
}

/** The selected current face must resolve uniquely; a matching infinite primitive elsewhere is not a substitute. */
export function selectedWeldCylinder(
  bodies: readonly SolidBody[], reference: SubShapeRef, placement: RigidPlacement, root: Vec3,
): CurrentCylinder | null {
  const candidates = bodies.filter(body => body.featureId === reference.bodyFeatureId);
  if (candidates.length !== 1 || !candidates[0].isValid || candidates[0].bodyKind !== 'solid') return null;
  const resolved = resolveSubShapeReference(candidates[0], reference);
  if (resolved.status !== 'matched' || resolved.match.geometry.kind !== 'face') return null;
  const cylinder = cylinderAt(resolved.match.geometry, placement, root);
  return cylinder?.side === 'interior' && !(Number.isFinite(candidates[0].volume) && candidates[0].volume > 0) ? null : cylinder;
}

/** Entire analytic contact arc and segment must fit this particular finite native band. */
export function cylindricalWeldCoversSegment(
  cylinder: CurrentCylinder, frame: WeldFrame, radius: number, arcLength: number, radialLeg: number, segment: WeldSegmentSpec,
): boolean {
  if (!Number.isFinite(radius) || radius <= WELD_LENGTH_TOLERANCE_MM
    || !Number.isFinite(arcLength) || arcLength <= 0 || !Number.isFinite(radialLeg) || radialLeg <= 0
    || !Number.isFinite(segment.start) || segment.start < 0 || !Number.isFinite(segment.length) || segment.length <= 0
    || !finite3(frame.origin) || !finite3(frame.xAxis) || !finite3(frame.yAxis) || !finite3(frame.zAxis)
    || [frame.xAxis, frame.yAxis, frame.zAxis].some(axis => Math.abs(lengthVec3(axis) - 1) > WELD_DIRECTION_TOLERANCE)) return false;
  const start = addVec3(frame.origin, scaleVec3(frame.zAxis, segment.start));
  const end = addVec3(start, scaleVec3(frame.zAxis, segment.length));
  const theta = arcLength / radius;
  if (!(theta > 0 && theta < Math.PI / 2) || !finite3(start) || !finite3(end)) return false;
  if (cylindricalWeldSection(cylinder.radius, cylinder.radius * theta, radialLeg, cylinder.side) === null) return false;
  const first = dotVec3(subVec3(start, cylinder.origin), cylinder.axis);
  const last = dotVec3(subVec3(end, cylinder.origin), cylinder.axis);
  const radial = subVec3(subVec3(start, cylinder.origin), scaleVec3(cylinder.axis, first));
  const distance = lengthVec3(radial);
  if (!(distance > 0) || !Number.isFinite(distance)) return false;
  const idealY = scaleVec3(radial, (cylinder.side === 'interior' ? -1 : 1) / distance);
  const idealZ = scaleVec3(cylinder.axis, dotVec3(cylinder.axis, frame.zAxis) >= 0 ? 1 : -1);
  if (Math.abs(radius - cylinder.radius) > WELD_LENGTH_TOLERANCE_MM
    || dotVec3(idealY, frame.yAxis) < 1 - WELD_DIRECTION_TOLERANCE
    || Math.abs(Math.abs(dotVec3(cylinder.axis, frame.zAxis)) - 1) > WELD_DIRECTION_TOLERANCE) return false;
  const tangent = crossVec3(idealY, idealZ), idealX = scaleVec3(tangent, 1 / lengthVec3(tangent));
  const sine = Math.sin(theta), dropFactor = 2 * Math.sin(theta / 2) ** 2;
  const width = radius * sine, drop = radius * dropFactor;
  // Compare P(t,u)=S+t*z+R*sin(u)*x +/- R*(1-cos(u))*y with the true
  // cylinder, 0<=t<=length, 0<=u<=theta<pi/2. Triangle inequality bounds
  // the complete surface, not only its root line or angular dot products. The
  // section also reaches the planar toe y=radialLeg; include that maximum for
  // the whole bead's displacement from its nonpenetrating ideal section.
  const error = Math.abs(distance - cylinder.radius)
    + segment.length * lengthVec3(subVec3(frame.zAxis, idealZ))
    + width * lengthVec3(subVec3(frame.xAxis, idealX))
    + Math.max(radialLeg, drop) * lengthVec3(subVec3(frame.yAxis, idealY))
    + Math.abs(radius - cylinder.radius) * (sine + dropFactor);
  // The ideal inner toe's opposite-wall clearance must also absorb the complete
  // section's positional error; passing each budget separately is insufficient.
  if (cylinder.side === 'interior'
    && !(cylinder.radius - (radialLeg - cylinder.radius) - error > WELD_LENGTH_TOLERANCE_MM)) return false;
  const axialWidth = width * Math.abs(dotVec3(frame.xAxis, cylinder.axis))
    + drop * Math.abs(dotVec3(frame.yAxis, cylinder.axis));
  return [first, last, error, axialWidth].every(Number.isFinite) && error <= WELD_LENGTH_TOLERANCE_MM
    && Math.min(first, last) - axialWidth >= cylinder.span[0] - WELD_LENGTH_TOLERANCE_MM
    && Math.max(first, last) + axialWidth <= cylinder.span[1] + WELD_LENGTH_TOLERANCE_MM;
}

/** Recheck actual complete band on new/edit plans. Unknown/partial geometry cannot inherit saved coverage. */
export function cylindricalWeldContact(
  bodies: readonly SolidBody[], placement: RigidPlacement, frame: WeldFrame, radius: number, arcLength: number, radialLeg: number,
  segment: WeldSegmentSpec, side: CylindricalWeldSide = 'exterior',
): boolean {
  if (side !== 'exterior' && side !== 'interior') return false;
  const start = addVec3(frame.origin, scaleVec3(frame.zAxis, segment.start));
  const matches: CurrentCylinder[] = [];
  for (const body of bodies) {
    if (!body.isValid || body.bodyKind !== 'solid'
      || (side === 'interior' && !(Number.isFinite(body.volume) && body.volume > 0))) continue;
    for (const face of body.faces) {
      const cylinder = cylinderAt(face, placement, start);
      if (cylinder === null || cylinder.side !== side
        || !cylindricalWeldCoversSegment(cylinder, frame, radius, arcLength, radialLeg, segment)) continue;
      matches.push(cylinder);
    }
  }
  return matches.length === 1;
}
