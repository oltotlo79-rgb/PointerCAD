import type { OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';

type Interval = readonly [number, number];
const PERIOD = 2 * Math.PI;
// Below the fastening contact tolerance (1e-6 mm); never enlarge an OCCT tolerance.
const LINEAR_TOLERANCE = 1e-7;
const MAX_NATIVE_TOLERANCE = 1e-6;

function usableTolerance(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_NATIVE_TOLERANCE;
}

/** Exactly one cover, allowing split arcs but neither gaps nor duplicate trim edges. */
function covers(intervals: readonly Interval[], low: number, high: number, tolerance: number): boolean {
  const ordered = [...intervals].sort((first, second) => first[0] - second[0]);
  let end = low;
  for (const interval of ordered) {
    if (Math.abs(interval[0] - end) > tolerance || interval[1] <= interval[0]) return false;
    end = interval[1];
  }
  return ordered.length > 0 && Math.abs(end - high) <= tolerance;
}

/** Lift an end-ring arc onto one period; a legitimate arc may cross the surface seam. */
function addArc(intervals: Interval[], first: number, last: number, origin: number, tolerance: number): boolean {
  const length = Math.abs(last - first);
  if (length <= tolerance || length > PERIOD + tolerance) return false;
  if (Math.abs(length - PERIOD) <= tolerance) {
    intervals.push([0, PERIOD]);
    return true;
  }
  let start = ((Math.min(first, last) - origin) % PERIOD + PERIOD) % PERIOD;
  if (PERIOD - start <= tolerance) start = 0;
  const end = start + length;
  if (end <= PERIOD + tolerance) intervals.push([start, Math.min(end, PERIOD)]);
  else intervals.push([start, PERIOD], [0, end - PERIOD]);
  return true;
}

/**
 * Certify a complete cylindrical band from ALL face p-curves, not UV bounds/area/centroid.
 * In cylinder parameters a circular end is a horizontal line. Actual seams are excluded
 * (BRep_Tool.IsClosed(edge, face): TWO p-curves on that face), including nonvertical/split seams.
 * Interior windows, partial circumference, sloped/unknown trims and incomplete data fail closed.
 * Split end arcs are accepted through interval coverage, not edge counts or a UV rectangle.
 *
 * Return physical offsets from axisOrigin along the already orientation-adjusted axis.
 * Cylinder V follows the underlying surface axis, which can be opposite to the face axis.
 * Evaluating the two analytic end circles also incorporates a possible Location scale.
 * All handles join the caller's per-face allocations, released on return AND exceptions.
 */
/** The trimmed cylindrical patch with the checks shared by the full-band and the patch-extent readers. */
function cylinderPatch(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  axisOrigin: Vec3Tuple,
  axis: Vec3Tuple | null,
  radius: number,
  allocations: Allocations,
) {
  if (axis === null || ![...axisOrigin, ...axis, radius].every(Number.isFinite) || radius <= 0) return null;
  const orientation = face.Orientation_1();
  if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) return null;
  const { keep } = allocations;
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return null;
  const uLow = adaptor.FirstUParameter(), uHigh = adaptor.LastUParameter();
  const vLow = adaptor.FirstVParameter(), vHigh = adaptor.LastVParameter();
  const transform = keep(adaptor.Trsf());
  const scale = Math.abs(transform.ScaleFactor());
  if (![uLow, uHigh, vLow, vHigh, scale].every(Number.isFinite) || scale <= 0) return null;
  const angleTolerance = Math.min(1e-9, LINEAR_TOLERANCE / radius);
  const vTolerance = LINEAR_TOLERANCE / scale;
  if (uHigh <= uLow || vHigh - vLow <= vTolerance) return null;
  if (!usableTolerance(oc.BRep_Tool.Tolerance_1(face))) return null;
  return { axis, adaptor, uLow, uHigh, vLow, vHigh, vTolerance, angleTolerance };
}

/**
 * Physical offsets from axisOrigin along the oriented axis of the two analytic end circles of the patch's V range.
 * The surface V can run opposite to the oriented face axis and can carry a Location scale, so the circles are evaluated
 * with adaptor.Value and projected (never raw V, never a global bounding box).
 */
function axialOffsets(
  patch: NonNullable<ReturnType<typeof cylinderPatch>>, axisOrigin: Vec3Tuple, allocations: Allocations,
): Interval | null {
  const { keep } = allocations;
  const { adaptor, axis, uLow, vLow, vHigh } = patch;
  const lower = keep(adaptor.Value(uLow, vLow)), upper = keep(adaptor.Value(uLow, vHigh));
  const offset = (x: number, y: number, z: number): number =>
    (x - axisOrigin[0]) * axis[0] + (y - axisOrigin[1]) * axis[1] + (z - axisOrigin[2]) * axis[2];
  const first = offset(lower.X(), lower.Y(), lower.Z());
  const last = offset(upper.X(), upper.Y(), upper.Z());
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return [Math.min(first, last) || 0, Math.max(first, last) || 0];
}

/**
 * Current axial extent of a trimmed cylindrical patch (runtime only). It does NOT certify a full circumference:
 * a split, windowed or helically trimmed wall also has one. Ordinary hole binding must keep using cylindricalFaceSpan.
 */
export function cylindricalFaceAxialExtent(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  axisOrigin: Vec3Tuple,
  axis: Vec3Tuple | null,
  radius: number,
  allocations: Allocations,
): Interval | null {
  const patch = cylinderPatch(oc, face, axisOrigin, axis, radius, allocations);
  return patch === null ? null : axialOffsets(patch, axisOrigin, allocations);
}

export function cylindricalFaceSpan(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  axisOrigin: Vec3Tuple,
  axis: Vec3Tuple | null,
  radius: number,
  allocations: Allocations,
): Interval | null {
  const patch = cylinderPatch(oc, face, axisOrigin, axis, radius, allocations);
  if (patch === null) return null;
  const { keep } = allocations;
  const { uLow, vLow, vHigh, vTolerance, angleTolerance } = patch;

  const lowerArcs: Interval[] = [], upperArcs: Interval[] = [];
  const shapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(face, shapes, true, true);
  for (let index = 1; index <= shapes.Size(); index += 1) {
    const shape = keep(shapes.FindKey(index));
    if (shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
    const edge = keep(oc.TopoDS.Edge_1(shape));
    if (oc.BRep_Tool.Degenerated(edge) || !usableTolerance(oc.BRep_Tool.Tolerance_2(edge))) return null;
    // A seam occurs twice on this face; it is not a physical boundary of the cylinder band.
    // Its path and number of segments do not certify circumference and must not restrict it.
    if (oc.BRep_Tool.IsClosed_2(edge, face)) continue;
    const curve = keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
    if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) return null;
    const first = curve.FirstParameter(), last = curve.LastParameter();
    if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
    const start = keep(curve.Value(first)), end = keep(curve.Value(last));
    const a = [start.X(), start.Y()], b = [end.X(), end.Y()];
    if (![...a, ...b].every(Number.isFinite)) return null;
    // Side cuts and internal windows remain physical boundaries, even with an on-axis centroid.
    if (Math.abs(a[1] - b[1]) > vTolerance) return null;
    const lower = Math.abs(a[1] - vLow) <= vTolerance && Math.abs(b[1] - vLow) <= vTolerance;
    const upper = Math.abs(a[1] - vHigh) <= vTolerance && Math.abs(b[1] - vHigh) <= vTolerance;
    if ((!lower && !upper) || !addArc(lower ? lowerArcs : upperArcs, a[0], b[0], uLow, angleTolerance)) return null;
  }
  if (!covers(lowerArcs, 0, PERIOD, angleTolerance) || !covers(upperArcs, 0, PERIOD, angleTolerance)) return null;
  return axialOffsets(patch, axisOrigin, allocations);
}
