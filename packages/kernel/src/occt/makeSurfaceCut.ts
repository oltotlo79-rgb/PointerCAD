import type {
  BRepAlgoAPI_BuilderAlgo, Message_ProgressRange, OpenCascadeInstance, TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { buildBooleanShape } from './buildBooleanShape.js';
import { continuousCurvePieces } from './continuousCurvePieces.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { boundingBoxOf, boundingBoxRange, type BoundingBoxRange } from './placeBodies.js';
import { shapeBodyKind } from './shapeBodyKind.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { booleanMargin } from './subShapes.js';

/** Geometry is already evaluated in millimetres; expression evaluation belongs to the caller. */
export type SurfaceCutInput =
  | { readonly kind: 'plane'; readonly origin: Vec3Tuple; readonly normal: Vec3Tuple }
  | {
    readonly kind: 'extrusion'; readonly profile: readonly CurveSpec[];
    readonly planeOrigin: Vec3Tuple; readonly planeNormal: Vec3Tuple;
  }
  /** An oriented finite face/shell, including an already clipped function surface. Never extended. */
  | { readonly kind: 'surface'; readonly shape: TopoDS_Shape };

export type SurfaceCutReason = 'non-finite-input' | 'invalid-blade' | 'non-planar-profile'
  | 'self-intersection' | 'no-intersection' | 'touch-only' | 'incomplete-cut' | 'ambiguous-side'
  | 'invalid-target' | 'boolean-failed' | 'volume-mismatch';

const MESSAGES: Readonly<Record<SurfaceCutReason, string>> = {
  'non-finite-input': '切断の座標・方向・範囲には有限な数を指定してください。',
  'invalid-blade': '切断には向きのそろった開いた曲線または面が必要です。',
  'non-planar-profile': '切断の曲線が指定したスケッチ平面に載っていません。',
  'self-intersection': '切断の曲線または面が自分自身と交わっています。',
  'no-intersection': '切断面が対象に届いていません。位置と範囲を見直してください。',
  'touch-only': '切断面が対象に接するだけで、立体を分けられません。',
  'incomplete-cut': '切断面の端が対象の中で止まるため、立体を完全に分けられません。',
  'ambiguous-side': '切断面に対する断片の側を一意に決められません。',
  'invalid-target': '切断する対象には有効な正の体積の立体が必要です。',
  'boolean-failed': '面による切断を計算できませんでした。形と範囲を見直してください。',
  'volume-mismatch': '切断前後の体積が必要な精度で一致しませんでした。',
};

export class SurfaceCutError extends Error {
  constructor(readonly code: SurfaceCutReason, options?: ErrorOptions) {
    super(MESSAGES[code], options);
    this.name = 'SurfaceCutError';
  }
}

export interface SurfaceCutPiece {
  /** +1 is the oriented blade normal side; extrusion normal = curve tangent cross planeNormal. */
  readonly side: -1 | 1;
  /** Borrowed from the result until result.delete(). Disconnected same-side solids form one union. */
  readonly shape: TopoDS_Shape;
  readonly volume: number;
  readonly solidCount: number;
}

export interface SurfaceCutResult {
  /** Exactly one union per side, ordered negative then positive. */
  readonly pieces: readonly SurfaceCutPiece[];
  readonly originalVolume: number;
  readonly originalSolidCount: number;
  readonly fragmentCount: number;
  readonly relativeVolumeError: number;
  /** Releases only owned output copies. Idempotent. Neither input is consumed. */
  delete(): void;
}

const VOLUME_RELATIVE_TOLERANCE = 1e-9;
const MIN_VOLUME = 1e-9;

function fail(code: SurfaceCutReason): never { throw new SurfaceCutError(code); }
function finite(values: readonly number[]): void {
  if (!values.every(Number.isFinite)) fail('non-finite-input');
}
function dot(a: Vec3Tuple, b: Vec3Tuple): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function subtract(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function offset(p: Vec3Tuple, n: Vec3Tuple, d: number): Vec3Tuple {
  return [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d];
}
function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(n: Vec3Tuple): Vec3Tuple {
  finite(n);
  const length = Math.hypot(...n);
  if (!(length > 0) || !Number.isFinite(length)) fail('invalid-blade');
  return [n[0] / length, n[1] / length, n[2] / length];
}

function boxCorners(box: BoundingBoxRange): Vec3Tuple[] {
  const result: Vec3Tuple[] = [];
  for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) {
    for (const z of [box.min[2], box.max[2]]) result.push([x, y, z]);
  }
  return result;
}

function members(oc: OpenCascadeInstance, shape: TopoDS_Shape, kind: 'solid' | 'face' | 'vertex',
  owned: Allocations): TopoDS_Shape[] {
  const type = kind === 'solid' ? oc.TopAbs_ShapeEnum.TopAbs_SOLID
    : kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE : oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
  const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const result: TopoDS_Shape[] = [];
  for (let i = 1; i <= map.Size(); i++) {
    // FindKey and TopoDS casts return owned wrappers; the caller's shape is never registered here.
    const item = owned.keep(map.FindKey(i));
    if (item.ShapeType() === type) result.push(item);
  }
  return result;
}

function copyShape(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations): TopoDS_Shape {
  const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(shape, true, false));
  return owned.keep(copier.Shape());
}

function hasGeneralSurface(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations): boolean {
  return members(oc, shape, 'face', owned).some(item => {
    const face = owned.keep(oc.TopoDS.Face_1(item));
    const adaptor = owned.keep(new oc.BRepAdaptor_Surface_2(face, false));
    const type = adaptor.GetType();
    return type !== oc.GeomAbs_SurfaceType.GeomAbs_Plane && type !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder;
  });
}

/** Fixed-order integration can conserve a sum while misallocating a cubic cut's individual volumes. */
function cutVolume(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const owned = createAllocations();
  try {
    if (!hasGeneralSurface(oc, shape, owned)) return measureVolume(oc, shape);
    const properties = owned.keep(new oc.GProp_GProps_1());
    const error = oc.BRepGProp.VolumePropertiesGK_1(shape, properties, 1e-12, false, true, false, false, false);
    const volume = properties.Mass();
    if (!Number.isFinite(error) || error < 0 || error > 1e-12 || !Number.isFinite(volume)) fail('volume-mismatch');
    return volume;
  } finally { owned.release(); }
}

function bounds(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations): BoundingBoxRange {
  const box = owned.keep(boundingBoxOf(oc, shape)).box;
  if (box.IsVoid() || box.IsOpen()) fail('non-finite-input');
  const result = boundingBoxRange(box);
  finite([...result.min, ...result.max]);
  return result;
}

function validateProfile(input: Extract<SurfaceCutInput, { kind: 'extrusion' }>, tolerance: number): Vec3Tuple {
  finite(input.planeOrigin);
  const normal = unit(input.planeNormal);
  if (input.profile.length === 0) fail('invalid-blade');
  const onPlane = (point: Vec3Tuple): void => {
    finite(point);
    if (Math.abs(dot(subtract(point, input.planeOrigin), normal)) > tolerance) fail('non-planar-profile');
  };
  for (const curve of input.profile) {
    if (curve.kind === 'segment') {
      onPlane(curve.from); onPlane(curve.to);
      if (Math.hypot(...subtract(curve.to, curve.from)) <= tolerance) fail('invalid-blade');
    } else if (curve.kind === 'spline') {
      if (curve.closed || curve.points.length < 2) fail('invalid-blade');
      for (const point of curve.points) onPlane(point);
      if (curve.knots !== undefined) finite(curve.knots);
    } else {
      onPlane(curve.center);
      const curveNormal = unit(curve.normal);
      const axis = unit(curve.kind === 'arc' ? curve.xAxis : curve.majorAxis);
      if (Math.abs(dot(curveNormal, normal)) < 1 - 1e-12 || Math.abs(dot(axis, normal)) > 1e-12
        || Math.abs(dot(axis, curveNormal)) > 1e-12) fail('non-planar-profile');
      const radii = curve.kind === 'arc' ? [curve.radius] : [curve.majorRadius, curve.minorRadius];
      finite(radii);
      if (radii.some(radius => radius <= tolerance)) fail('invalid-blade');
      if (curve.kind === 'ellipse' && curve.majorRadius < curve.minorRadius) fail('invalid-blade');
      if (curve.startAngle === undefined || curve.endAngle === undefined) fail('invalid-blade');
      finite([curve.startAngle, curve.endAngle]);
      const sweep = Math.abs(curve.endAngle - curve.startAngle);
      if (!(sweep > 0) || sweep >= 2 * Math.PI - 1e-9) fail('invalid-blade');
    }
  }
  return normal;
}

function planeBlade(oc: OpenCascadeInstance, input: Extract<SurfaceCutInput, { kind: 'plane' }>,
  box: BoundingBoxRange, size: number, owned: Allocations): TopoDS_Shape {
  finite(input.origin);
  const normal = unit(input.normal);
  const center: Vec3Tuple = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2];
  const projected = offset(center, normal, -dot(subtract(center, input.origin), normal));
  finite(projected);
  const x = unit(cross(Math.abs(normal[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0], normal));
  const y = cross(normal, x);
  const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => offset(offset(projected, x, u * size), y, v * size));
  const profile: CurveSpec[] = points.map((from, i) => ({ kind: 'segment', from, to: points[(i + 1) % 4] }));
  return owned.keep(makePlanarFace(oc, profile)).face;
}

function extrusionBlade(oc: OpenCascadeInstance, input: Extract<SurfaceCutInput, { kind: 'extrusion' }>,
  box: BoundingBoxRange, margin: number, tolerance: number, owned: Allocations): TopoDS_Shape {
  const normal = validateProfile(input, tolerance);
  const projections = boxCorners(box).map(p => dot(subtract(p, input.planeOrigin), normal));
  const low = Math.min(...projections) - margin, high = Math.max(...projections) + margin;
  finite([low, high, high - low]);
  const maker = owned.keep(new oc.BRepBuilderAPI_MakeWire_1());
  let previous: Vec3Tuple | undefined;
  let first: Vec3Tuple | undefined;
  for (const curve of continuousCurvePieces(input.profile)) {
    const edge = owned.keep(makeCurveEdge(oc, curve)).edge;
    const adaptor = owned.keep(new oc.BRepAdaptor_Curve_2(edge));
    const reversed = edge.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const from = owned.keep(adaptor.Value(reversed ? adaptor.LastParameter() : adaptor.FirstParameter()));
    const to = owned.keep(adaptor.Value(reversed ? adaptor.FirstParameter() : adaptor.LastParameter()));
    const start: Vec3Tuple = [from.X(), from.Y(), from.Z()], end: Vec3Tuple = [to.X(), to.Y(), to.Z()];
    finite([...start, ...end]);
    if (previous !== undefined && Math.hypot(...subtract(start, previous)) > tolerance) fail('invalid-blade');
    first ??= start;
    previous = end;
    maker.Add_1(edge);
    if (!maker.IsDone()) fail('invalid-blade');
  }
  if (first === undefined || previous === undefined || Math.hypot(...subtract(first, previous)) <= tolerance) fail('invalid-blade');
  const wire = owned.keep(maker.Wire());
  const vector = owned.keep(new oc.gp_Vec_4(...offset([0, 0, 0], normal, low)));
  const translation = owned.keep(new oc.gp_Trsf_1());
  translation.SetTranslation_1(vector);
  const moved = owned.keep(new oc.BRepBuilderAPI_Transform_2(wire, translation, true));
  const base = owned.keep(moved.Shape());
  const sweep = owned.keep(new oc.gp_Vec_4(...offset([0, 0, 0], normal, high - low)));
  const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(base, sweep, false, true));
  if (!prism.IsDone()) fail('invalid-blade');
  const shape = owned.keep(prism.Shape());
  // OCCT orients the swept wire like the lateral boundary of an extruded face: extrusion cross
  // tangent. Our curve contract uses tangent cross extrusion, including reversed curve traversal.
  shape.Reverse();
  return shape;
}

function validateBlade(oc: OpenCascadeInstance, blade: TopoDS_Shape, range: Message_ProgressRange,
  owned: Allocations): void {
  if (blade.IsNull() || members(oc, blade, 'face', owned).length === 0
    || members(oc, blade, 'solid', owned).length !== 0 || !isValidShape(oc, blade)) fail('invalid-blade');
  bounds(oc, blade, owned);
  const check = owned.keep(new oc.BRepAlgoAPI_Check_1());
  check.SetRunParallel(false);
  check.SetData_1(blade, false, true);
  check.Perform(range);
  if (check.HasErrors() || !check.IsValid()) fail('self-intersection');
}

function bladeImages(oc: OpenCascadeInstance, builder: BRepAlgoAPI_BuilderAlgo, blade: TopoDS_Shape,
  owned: Allocations): TopoDS_Shape[] {
  const result: TopoDS_Shape[] = [];
  for (const face of members(oc, blade, 'face', owned)) {
    const list = owned.keep(builder.Modified(face));
    // Copy before RemoveFirst: never mutate the builder's borrowed native history list.
    const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
    if (copy.Size() === 0 && !builder.IsDeleted(face)) result.push(face);
    while (copy.Size() > 0) {
      const image = owned.keep(copy.First_1());
      if (image.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) fail('boolean-failed');
      result.push(image);
      copy.RemoveFirst();
    }
  }
  return result;
}

/**
 * Like ellipseBoolean, change units by an exact power of two to resolve OCCT's fixed 1e-7
 * intersection approximation more finely. General Fuse needs its own correspondence through the
 * inverse transform: ellipseBoolean.finish requires a BooleanOperation, not the bound BuilderAlgo.
 * Native shape tolerances are scaled and restored by OCCT; no tolerance is overwritten here.
 * This is numerical conditioning, not a substitute for the analytic and conservation checks.
 */
function splitCoordinates(oc: OpenCascadeInstance, target: TopoDS_Shape, blade: TopoDS_Shape,
  owned: Allocations) {
  const unchanged = { target, blade, restore: (shape: TopoDS_Shape, images: readonly TopoDS_Shape[]) => ({ shape, images }) };
  if (!hasGeneralSurface(oc, blade, owned)) return unchanged;
  const box = bounds(oc, target, owned), bladeBox = bounds(oc, blade, owned);
  const centre: Vec3Tuple = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2];
  const scale = 4096;
  if (centre.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9)
    || Math.hypot(...subtract(box.max, box.min)) < 1e-4
    || [...boxCorners(box), ...boxCorners(bladeBox)].some(point =>
      point.some((value, axis) => Math.abs(value - centre[axis]) * scale > 1e8))) return unchanged;
  const transform = owned.keep(new oc.gp_Trsf_1());
  transform.SetValues(scale, 0, 0, -scale * centre[0], 0, scale, 0, -scale * centre[1], 0, 0, scale, -scale * centre[2]);
  const inverse = owned.keep(transform.Inverted());
  const move = (shape: TopoDS_Shape): TopoDS_Shape => {
    const maker = owned.keep(new oc.BRepBuilderAPI_Transform_2(shape, transform, true));
    if (!maker.IsDone()) fail('boolean-failed');
    return owned.keep(maker.Shape());
  };
  return { target: move(target), blade: move(blade), restore(shape: TopoDS_Shape, images: readonly TopoDS_Shape[]) {
    // Transform the complete result once, then map its faces. Independently transforming each
    // history face would lose IsSame identity and make a geometrically valid cut unclassifiable.
    const maker = owned.keep(new oc.BRepBuilderAPI_Transform_2(shape, inverse, true));
    if (!maker.IsDone()) fail('boolean-failed');
    return { shape: owned.keep(maker.Shape()), images: images.map(face => {
      const mapped = owned.keep(maker.ModifiedShape(face));
      // ModifiedShape's stored occurrence can carry a solid's boundary orientation. The source
      // history face carries the blade orientation, which positive uniform scaling preserves.
      return owned.keep(mapped.Oriented(face.Orientation_1()));
    }) };
  } };
}

/** A solid's outward boundary opposes the blade normal exactly on the positive side. */
function fragmentSide(oc: OpenCascadeInstance, solid: TopoDS_Shape, images: readonly TopoDS_Shape[],
  owned: Allocations): -1 | 1 | null {
  let side: -1 | 1 | null = null;
  for (const face of members(oc, solid, 'face', owned)) {
    const image = images.find(candidate => candidate.IsSame(face));
    if (image === undefined) continue;
    const orientation = face.Orientation_1();
    if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) {
      fail('incomplete-cut');
    }
    const next = orientation === image.Orientation_1() ? -1 : 1;
    if (side !== null && side !== next) fail('ambiguous-side');
    side = next;
  }
  return side;
}

function uncutPlaneSide(oc: OpenCascadeInstance, solid: TopoDS_Shape,
  input: Extract<SurfaceCutInput, { kind: 'plane' }>, tolerance: number, owned: Allocations): -1 | 1 {
  const normal = unit(input.normal);
  for (const vertex of members(oc, solid, 'vertex', owned)) {
    const p = owned.keep(oc.BRep_Tool.Pnt(owned.keep(oc.TopoDS.Vertex_1(vertex))));
    const distance = dot(subtract([p.X(), p.Y(), p.Z()], input.origin), normal);
    if (Math.abs(distance) > tolerance) return distance < 0 ? -1 : 1;
  }
  return fail('ambiguous-side');
}

function noSplitReason(oc: OpenCascadeInstance, target: TopoDS_Shape, blade: TopoDS_Shape,
  tolerance: number, range: Message_ProgressRange, owned: Allocations): never {
  const distance = owned.keep(new oc.BRepExtrema_DistShapeShape_1());
  distance.LoadS1(target); distance.LoadS2(blade);
  distance.SetMultiThread(false);
  if (!distance.Perform(range) || !distance.IsDone()) fail('boolean-failed');
  return fail(distance.Value() > tolerance ? 'no-intersection' : 'touch-only');
}

/**
 * Split using the fixed build's General Fuse (there is no Splitter binding). Only the actual finite
 * blade participates. An internal stopping face is rejected before it can be mistaken for a cut.
 * Analytic curves stay analytic; certified function chords/cubics retain their supplied geometry.
 * Their approximation error is separate from the 1e-9 conservation check and belongs to the
 * caller's original-function certificate (for a graph, |delta y| <= e gives E <= e * width * depth).
 * An untouched disconnected component is classified analytically for a plane; for a finite curved
 * blade its side need not be globally defined, so the operation rejects it as ambiguous-side.
 *
 * Work takes place on deep copies. All native temporaries are released before returning independent
 * output copies; a failed call releases everything and does not delete or modify either borrowed input.
 */
export function makeSurfaceCut(oc: OpenCascadeInstance, target: TopoDS_Shape, input: SurfaceCutInput): SurfaceCutResult {
  const work = createAllocations(), output = createAllocations();
  try {
    if (input.kind === 'plane') { finite(input.origin); unit(input.normal); }
    if (input.kind === 'extrusion') validateProfile(input, oc.Precision.Confusion());
    if (target.IsNull()) fail('invalid-target');
    const copy = copyShape(oc, target, work);
    if (shapeBodyKind(oc, copy) !== 'solid' || !isValidShape(oc, copy)) fail('invalid-target');
    const originals = members(oc, copy, 'solid', work);
    if (originals.length === 0) fail('invalid-target');
    const originalVolumes = originals.map(solid => cutVolume(oc, solid));
    if (originalVolumes.some(volume => !Number.isFinite(volume) || volume <= MIN_VOLUME)) fail('invalid-target');
    const originalVolume = originalVolumes.reduce((sum, volume) => sum + volume, 0);
    const box = bounds(oc, copy, work), diagonal = Math.hypot(...subtract(box.max, box.min));
    const tolerance = Math.max(oc.Precision.Confusion(), diagonal * 1e-12);
    const margin = booleanMargin(diagonal);
    const range = work.keep(new oc.Message_ProgressRange_1());
    if (input.kind === 'surface' && input.shape.IsNull()) fail('invalid-blade');
    const blade = input.kind === 'plane' ? planeBlade(oc, input, box, diagonal + margin, work)
      : input.kind === 'extrusion' ? extrusionBlade(oc, input, box, margin, tolerance, work)
        : copyShape(oc, input.shape, work);
    validateBlade(oc, blade, range, work);
    const coordinates = splitCoordinates(oc, copy, blade, work);
    const list = work.keep(new oc.TopTools_ListOfShape_1());
    work.keep(list.Append_1(coordinates.target)); work.keep(list.Append_1(coordinates.blade));
    const builder = work.keep(new oc.BRepAlgoAPI_BuilderAlgo_1());
    builder.SetNonDestructive(true); builder.SetRunParallel(false); builder.SetToFillHistory(true);
    builder.SetArguments(list); builder.Build(range);
    if (builder.HasErrors() || !builder.IsDone()) fail('boolean-failed');
    const nativeSplit = work.keep(builder.Shape());
    const restored = coordinates.restore(nativeSplit, bladeImages(oc, builder, coordinates.blade, work));
    const fragments = members(oc, restored.shape, 'solid', work), images = restored.images;
    const sides = fragments.map(solid => fragmentSide(oc, solid, images, work));
    if (fragments.length <= originals.length) noSplitReason(oc, copy, blade, tolerance, range, work);
    const groups: Record<-1 | 1, TopoDS_Shape[]> = { [-1]: [], 1: [] };
    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i];
      if (!isValidShape(oc, fragment)) fail('boolean-failed');
      const side = sides[i] ?? (input.kind === 'plane' ? uncutPlaneSide(oc, fragment, input, tolerance, work) : fail('ambiguous-side'));
      groups[side].push(fragment);
    }
    if (groups[-1].length === 0 || groups[1].length === 0) fail('incomplete-cut');
    const pieces: SurfaceCutPiece[] = [];
    for (const side of [-1, 1] as const) {
      const group = groups[side];
      const union = group.length === 1 ? group[0] : buildBooleanShape(oc, 'union', group[0], group.slice(1), range, work);
      if (!isValidShape(oc, union)) fail('boolean-failed');
      const volume = cutVolume(oc, union);
      if (!Number.isFinite(volume) || volume <= MIN_VOLUME) fail('boolean-failed');
      const shape = copyShape(oc, union, output);
      pieces.push({ side, shape, volume, solidCount: members(oc, union, 'solid', work).length });
    }
    const relativeVolumeError = Math.abs(pieces.reduce((sum, p) => sum + p.volume, 0) - originalVolume) / originalVolume;
    if (!Number.isFinite(relativeVolumeError) || relativeVolumeError > VOLUME_RELATIVE_TOLERANCE) fail('volume-mismatch');
    return { pieces, originalVolume, originalSolidCount: originals.length, fragmentCount: fragments.length,
      relativeVolumeError, delete: output.release };
  } catch (error) {
    output.release();
    if (error instanceof SurfaceCutError) throw error;
    throw new SurfaceCutError('boolean-failed', { cause: error });
  } finally { work.release(); }
}
