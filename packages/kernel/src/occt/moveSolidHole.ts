import type { OpenCascadeInstance, TopoDS_Face, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { booleanOp, type BooleanResult } from './booleanOp.js';
import { cylindricalFaceSpan } from './cylindricalFaceSpan.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';

const LINEAR_TOLERANCE_MM = 1e-6;
const WALL_CLEARANCE_MM = 1e-7;
const SIGNATURE_TOLERANCE = 1e-9;
const VOLUME_RELATIVE_TOLERANCE = 1e-9;

export const HOLE_MOVE_DELTA_MESSAGE = '穴の移動量は、穴の軸に直角な 0 でない有限のベクトルで指定してください。';
export const HOLE_MOVE_MISSING_FACE_MESSAGE = '選んだ面は元の立体に属していません。穴の面を選び直してください。';
export const HOLE_MOVE_NOT_HOLE_MESSAGE = '動かせるのは、内側が円筒になっている穴の面だけです。';
export const HOLE_MOVE_PARTIAL_MESSAGE = '全周がつながった一定径の貫通穴だけ動かせます。';
export const HOLE_MOVE_PLATE_MESSAGE = 'この操作は、六つの平面と一つの円筒面からなる長方形の穴あき板だけに対応しています。';
export const HOLE_MOVE_COLLISION_MESSAGE = '穴を動かすと板の外周に届くため動かせません。移動量を見直してください。';
export const HOLE_MOVE_FAILED_MESSAGE = '穴を動かせませんでした。元の立体と移動量を見直してください。';

/** Shape and its builders remain owned by this handle until delete(), as for editSolidFace. */
export type HoleMoveResult = BooleanResult;

interface PlaneSignature {
  readonly centroid: Vec3Tuple;
  readonly normal: Vec3Tuple;
  readonly area: number;
}

interface HoleGeometry {
  readonly start: Vec3Tuple;
  readonly direction: Vec3Tuple;
  readonly radius: number;
  readonly depth: number;
}

interface PlateGeometry {
  readonly hole: HoleGeometry;
  readonly sides: readonly PlaneSignature[];
  readonly caps: readonly PlaneSignature[];
  readonly filledVolume: number;
  readonly volume: number;
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function addScaled(a: Vec3Tuple, b: Vec3Tuple, scale = 1): Vec3Tuple {
  return [a[0] + scale * b[0], a[1] + scale * b[1], a[2] + scale * b[2]];
}

function separation(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(...subtract(a, b));
}

function parallel(a: Vec3Tuple, b: Vec3Tuple): boolean {
  return Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    <= SIGNATURE_TOLERANCE;
}

function assertVolume(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || !(expected > 0)
    || Math.abs(actual - expected) / expected > VOLUME_RELATIVE_TOLERANCE) {
    throw new Error(HOLE_MOVE_FAILED_MESSAGE);
  }
}

/** All native return values here are owned wrappers, including Axis/Location/Direction. No Handle.get borrow is deleted. */
function readHole(oc: OpenCascadeInstance, face: TopoDS_Face, owned: Allocations): HoleGeometry {
  const { keep } = owned;
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) throw new Error(HOLE_MOVE_NOT_HOLE_MESSAGE);
  const cylinder = keep(adaptor.Cylinder());
  const orientation = face.Orientation_1();
  if ((orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED)
    || cylinder.Direct() !== (orientation === oc.TopAbs_Orientation.TopAbs_REVERSED)) {
    throw new Error(HOLE_MOVE_NOT_HOLE_MESSAGE);
  }
  const axis = keep(cylinder.Axis()), location = keep(axis.Location()), along = keep(axis.Direction());
  const origin: Vec3Tuple = [location.X(), location.Y(), location.Z()];
  const direction: Vec3Tuple = [along.X(), along.Y(), along.Z()];
  const radius = cylinder.Radius();
  // UV bounds alone also describe partial/windowed cylinders. Reuse the end-ring/p-curve proof.
  const span = cylindricalFaceSpan(oc, face, origin, direction, radius, owned);
  if (span === null || span[1] - span[0] <= LINEAR_TOLERANCE_MM) throw new Error(HOLE_MOVE_PARTIAL_MESSAGE);
  return { start: addScaled(origin, direction, span[0]), direction, radius, depth: span[1] - span[0] };
}

function readPlane(oc: OpenCascadeInstance, face: TopoDS_Face, owned: Allocations): PlaneSignature {
  const { keep } = owned;
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) throw new Error(HOLE_MOVE_PLATE_MESSAGE);
  const plane = keep(adaptor.Plane()), axis = keep(plane.Axis()), direction = keep(axis.Direction());
  const sign = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
  const props = keep(new oc.GProp_GProps_1());
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const centre = keep(props.CentreOfMass());
  return { centroid: [centre.X(), centre.Y(), centre.Z()], area: props.Mass(),
    normal: [sign * direction.X(), sign * direction.Y(), sign * direction.Z()] };
}

function faceMap(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations) {
  const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), map);
  return map;
}

/** Limit the operation to the W16 topology: a rectangular plate with one straight through-hole. */
function readPlate(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, selected: TopoDS_Face, owned: Allocations,
): PlateGeometry {
  const hole = readHole(oc, selected, owned), map = faceMap(oc, shape, owned);
  if (map.Size() !== 7 || map.FindIndex(selected) < 1) throw new Error(HOLE_MOVE_PLATE_MESSAGE);
  const caps: PlaneSignature[] = [], sides: PlaneSignature[] = [];
  for (let i = 1; i <= map.Size(); i++) {
    const face = owned.keep(oc.TopoDS.Face_1(owned.keep(map.FindKey(i))));
    if (face.IsSame(selected)) continue;
    const plane = readPlane(oc, face, owned);
    if (parallel(plane.normal, hole.direction)) caps.push(plane);
    else if (Math.abs(dot(plane.normal, hole.direction)) <= SIGNATURE_TOLERANCE) sides.push(plane);
    else throw new Error(HOLE_MOVE_PLATE_MESSAGE);
  }
  if (caps.length !== 2 || sides.length !== 4) throw new Error(HOLE_MOVE_PLATE_MESSAGE);
  const end = addScaled(hole.start, hole.direction, hole.depth);
  for (const cap of caps) {
    const isEnd = dot(cap.normal, hole.direction) > 0;
    if (Math.abs(dot(subtract(cap.centroid, isEnd ? end : hole.start), hole.direction)) > LINEAR_TOLERANCE_MM) {
      throw new Error(HOLE_MOVE_PLATE_MESSAGE);
    }
  }
  if (dot(caps[0].normal, caps[1].normal) > -1 + SIGNATURE_TOLERANCE) throw new Error(HOLE_MOVE_PLATE_MESSAGE);
  const widths = sides.map(side => {
    const opposite = sides.filter(other => parallel(side.normal, other.normal) && dot(side.normal, other.normal) < 0);
    if (opposite.length !== 1 || sides.some(other => !parallel(side.normal, other.normal)
      && Math.abs(dot(side.normal, other.normal)) > SIGNATURE_TOLERANCE)) throw new Error(HOLE_MOVE_PLATE_MESSAGE);
    return dot(subtract(side.centroid, opposite[0].centroid), side.normal);
  }).sort((a, b) => a - b);
  const capArea = widths[0] * widths[3];
  if (!(widths[0] > 2 * hole.radius) || !(widths[3] > 2 * hole.radius)
    || caps.some(cap => Math.abs(cap.area - (capArea - Math.PI * hole.radius ** 2)) > SIGNATURE_TOLERANCE)) {
    throw new Error(HOLE_MOVE_PLATE_MESSAGE);
  }
  const filledVolume = capArea * hole.depth;
  const volume = filledVolume - Math.PI * hole.radius ** 2 * hole.depth;
  assertVolume(measureVolume(oc, shape), volume);
  return { hole, sides, caps, filledVolume, volume };
}

function assertInside(sides: readonly PlaneSignature[], hole: HoleGeometry, delta: Vec3Tuple): void {
  const destination = addScaled(hole.start, delta);
  if (sides.some(side => dot(subtract(side.centroid, destination), side.normal) - hole.radius <= WALL_CLEARANCE_MM)) {
    throw new Error(HOLE_MOVE_COLLISION_MESSAGE);
  }
}

function unify(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations): TopoDS_Shape {
  const maker = owned.keep(new oc.ShapeUpgrade_UnifySameDomain_1());
  maker.SetSafeInputMode(true);
  maker.Initialize(shape, true, true, false);
  maker.AllowInternalEdges(false);
  maker.Build();
  return owned.keep(maker.Shape());
}

function assertResult(
  oc: OpenCascadeInstance, shape: TopoDS_Shape, before: PlateGeometry, delta: Vec3Tuple, owned: Allocations,
): number {
  if (shape.IsNull() || countSolidShapes(oc, shape, 2) !== 1 || !isValidShape(oc, shape)) {
    throw new Error(HOLE_MOVE_FAILED_MESSAGE);
  }
  const faces = faceMap(oc, shape, owned);
  let selected: TopoDS_Face | undefined;
  for (let i = 1; i <= faces.Size(); i++) {
    const face = owned.keep(oc.TopoDS.Face_1(owned.keep(faces.FindKey(i))));
    const adaptor = owned.keep(new oc.BRepAdaptor_Surface_2(face, false));
    if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      if (selected !== undefined) throw new Error(HOLE_MOVE_FAILED_MESSAGE);
      selected = face;
    }
  }
  if (selected === undefined) throw new Error(HOLE_MOVE_FAILED_MESSAGE);
  const after = readPlate(oc, shape, selected, owned);
  const centre = (hole: HoleGeometry): Vec3Tuple => addScaled(hole.start, hole.direction, hole.depth / 2);
  if (!parallel(before.hole.direction, after.hole.direction)
    || separation(addScaled(centre(before.hole), delta), centre(after.hole)) > LINEAR_TOLERANCE_MM
    || Math.abs(before.hole.radius - after.hole.radius) > SIGNATURE_TOLERANCE
    || Math.abs(before.hole.depth - after.hole.depth) > SIGNATURE_TOLERANCE) throw new Error(HOLE_MOVE_FAILED_MESSAGE);
  for (const side of before.sides) {
    const matches = after.sides.filter(other => separation(side.normal, other.normal) <= SIGNATURE_TOLERANCE
      && separation(side.centroid, other.centroid) <= SIGNATURE_TOLERANCE
      && Math.abs(side.area - other.area) <= SIGNATURE_TOLERANCE);
    if (matches.length !== 1) throw new Error(HOLE_MOVE_FAILED_MESSAGE);
  }
  const volume = measureVolume(oc, shape);
  assertVolume(volume, before.volume);
  return volume;
}

/**
 * Move one full cylindrical through-hole within a six-plane rectangular plate (W16/H1).
 * delta is in world mm and perpendicular to the hole axis; this is not a whole-body translation.
 * solid and cylindricalFace are borrowed and never deleted or changed. The face must actually belong
 * to solid (even an identical face from another body is refused). Saved-reference resolution belongs to K1.
 *
 * The selected cylinder supplies the plug's axis/radius/depth. All modelling is performed on a deep
 * geometry copy: fill the old hole, translate the plug, subtract, then unify coplanar faces.
 * Every temporary/returned wrapper and Boolean owner is released in reverse order, including exceptions.
 * Caller owns the result handle and calls delete(); repeated delete() is safe. Refusals throw an Error.
 * H2 will extend real-shape refusal coverage; arbitrary topology/STEP, multiple/blind holes are not supported.
 */
export function moveSolidHole(
  oc: OpenCascadeInstance, solid: TopoDS_Shape, cylindricalFace: TopoDS_Face, delta: Vec3Tuple,
): HoleMoveResult {
  if (!delta.every(Number.isFinite) || Math.hypot(...delta) < LINEAR_TOLERANCE_MM) {
    throw new Error(HOLE_MOVE_DELTA_MESSAGE);
  }
  const owned = createAllocations(), { keep } = owned;
  try {
    if (solid.IsNull() || countSolidShapes(oc, solid, 2) !== 1 || !isValidShape(oc, solid)) {
      throw new Error(HOLE_MOVE_PLATE_MESSAGE);
    }
    const originalFaces = faceMap(oc, solid, owned);
    if (cylindricalFace.IsNull() || originalFaces.FindIndex(cylindricalFace) < 1) {
      throw new Error(HOLE_MOVE_MISSING_FACE_MESSAGE);
    }
    const copier = keep(new oc.BRepBuilderAPI_Copy_2(solid, true, false));
    const copied = keep(copier.Shape());
    // ModifiedShape identifies the copied TShape but does not retain its orientation in the solid.
    // Resolve that identity in the copied body to recover the material-facing orientation (H1 real-shape regression).
    // Both return values are owned wrappers; neither refers to the original's shared geometry.
    const mapped = keep(copier.ModifiedShape(cylindricalFace));
    const copiedFaces = faceMap(oc, copied, owned), position = copiedFaces.FindIndex(mapped);
    if (position < 1) throw new Error(HOLE_MOVE_MISSING_FACE_MESSAGE);
    const selected = keep(oc.TopoDS.Face_1(keep(copiedFaces.FindKey(position))));
    const before = readPlate(oc, copied, selected, owned), { hole } = before;
    if (Math.abs(dot(delta, hole.direction)) > SIGNATURE_TOLERANCE) throw new Error(HOLE_MOVE_DELTA_MESSAGE);
    assertInside(before.sides, hole, [0, 0, 0]);
    assertInside(before.sides, hole, delta);
    const start = keep(new oc.gp_Pnt_3(...hole.start)), direction = keep(new oc.gp_Dir_4(...hole.direction));
    const axes = keep(new oc.gp_Ax2_3(start, direction));
    const plug = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, hole.radius, hole.depth)).Shape());
    const filled = keep(booleanOp(oc, 'union', copied, plug));
    assertVolume(filled.volume, before.filledVolume);
    const transform = keep(new oc.gp_Trsf_1());
    transform.SetTranslation_1(keep(new oc.gp_Vec_4(...delta)));
    const moved = keep(keep(new oc.BRepBuilderAPI_Transform_2(plug, transform, true)).Shape());
    const cut = keep(booleanOp(oc, 'subtract', filled.shape, moved, undefined, undefined, { requireRemoval: true }));
    const shape = unify(oc, cut.shape, owned);
    const volume = assertResult(oc, shape, before, delta, owned);
    return { shape, volume, delete: owned.release };
  } catch (error) {
    owned.release();
    throw error instanceof Error ? error : new Error(HOLE_MOVE_FAILED_MESSAGE);
  }
}
