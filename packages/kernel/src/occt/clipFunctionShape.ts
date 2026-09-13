/** Clip actual function edges/surfaces to a finite XYZ box. Never manufacture closing faces. */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { makeBox, type OcctShapeHandle } from './makeBox.js';
import { isValidShape } from './solidMesh.js';
import { IDENTITY_TRANSFORM, makeCompound, transformShape } from './transformShape.js';

/** Kernel DTO in mm. The receiving boundary checks every endpoint again. */
export interface FunctionClipBox { readonly minimum: Vec3Tuple; readonly maximum: Vec3Tuple }
export const FUNCTION_CLIP_BOUND_TOLERANCE=1e-6;
export type FunctionClipDimension = 'edge' | 'face';
export type FunctionClipResult =
  | { readonly status: 'empty' }
  | (OcctShapeHandle & { readonly status: 'shape'; readonly count: number });

export function validateFunctionClipBox(box: FunctionClipBox): Vec3Tuple {
  if (box === null || typeof box !== 'object') throw new Error('X・Y・Zの描画範囲を指定してください。');
  const { minimum, maximum } = box;
  if (!Array.isArray(minimum) || !Array.isArray(maximum) || minimum.length !== 3 || maximum.length !== 3) {
    throw new Error('X・Y・Zの各軸に最小値と最大値を指定してください。');
  }
  const span = (axis: number): number => {
    const lo: unknown = minimum[axis], hi: unknown = maximum[axis];
    if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi)
      || !(lo < hi) || !Number.isFinite(hi - lo)) {
      throw new Error('描画範囲は各軸とも有限の最小値 < 最大値にしてください。');
    }
    return hi - lo;
  };
  return [span(0), span(1), span(2)];
}

/** BRep tolerances are independent of a display mesh. Reject a failed geometric clipping postcondition. */
function measuredBounds(oc: OpenCascadeInstance, shape: TopoDS_Shape, allocations: Allocations): FunctionClipBox {
  const bounds = allocations.keep(new oc.Bnd_Box_1());
  // Unlike Add, this measures trimmed spline geometry rather than a larger control-point enclosure.
  oc.BRepBndLib.AddOptimal(shape, bounds, false, false);
  if (bounds.IsVoid()) throw new Error('切り取った関数の範囲を確認できませんでした。');
  bounds.SetGap(0);
  const low = allocations.keep(bounds.CornerMin()), high = allocations.keep(bounds.CornerMax());
  const minimum: Vec3Tuple = [low.X(), low.Y(), low.Z()], maximum: Vec3Tuple = [high.X(), high.Y(), high.Z()];
  return { minimum,maximum };
}
export function verifyFunctionShapeBounds(oc: OpenCascadeInstance, shape: TopoDS_Shape, limits: FunctionClipBox, allocations: Allocations): void {
  const { minimum,maximum } = measuredBounds(oc,shape,allocations);
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(minimum[axis]) || !Number.isFinite(maximum[axis])
      || minimum[axis] < limits.minimum[axis] - FUNCTION_CLIP_BOUND_TOLERANCE || maximum[axis] > limits.maximum[axis] + FUNCTION_CLIP_BOUND_TOLERANCE) {
      throw new Error('関数の形が指定したXYZ範囲に収まりませんでした。');
    }
  }
}

/** Unique wrappers belong to this call. The underlying input geometry stays borrowed. */
function elements(oc: OpenCascadeInstance, shape: TopoDS_Shape, dimension: FunctionClipDimension,
  allocations: Allocations): readonly TopoDS_Shape[] {
  const map = allocations.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const expected = dimension === 'edge' ? oc.TopAbs_ShapeEnum.TopAbs_EDGE : oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const result: TopoDS_Shape[] = [];
  for (let index = 1; index <= map.Size(); index++) {
    const candidate = allocations.keep(map.FindKey(index));
    if (candidate.ShapeType() === expected) result.push(candidate);
  }
  return result;
}

/**
 * Extract the source faces before intersection, including for a closed source. Intersecting
 * a solid with a box would add the box's caps, which are not part of the user's function.
 * Curve tangencies that only leave isolated vertices are not invented as zero-length edges.
 */
export function clipFunctionShape(oc: OpenCascadeInstance, source: TopoDS_Shape,
  box: FunctionClipBox, dimension: FunctionClipDimension): FunctionClipResult {
  const [dx, dy, dz] = validateFunctionClipBox(box); // Before allocating any WASM object.
  if (dimension !== 'edge' && dimension !== 'face') throw new Error('関数の辺または面を指定してください。');
  const allocations = createAllocations(), { keep, release } = allocations;
  try {
    const originals = elements(oc, source, dimension, allocations);
    if (originals.length === 0) { release(); return { status: 'empty' }; }
    const target = keep(makeCompound(oc, originals));
    // A geometric enclosure proves all of the actual shape is inside. Avoid a global Boolean
    // between thousands of already-contained triangles and the box; samples alone do not grant this path.
    const enclosed = measuredBounds(oc,target.shape,allocations);
    if (enclosed.minimum.every((value,axis) => Number.isFinite(value) && value >= box.minimum[axis]
      && Number.isFinite(enclosed.maximum[axis]) && enclosed.maximum[axis] <= box.maximum[axis])) {
      if (!isValidShape(oc,target.shape)) throw new Error('関数の形が正しくありません。');
      return { status:'shape',shape:target.shape,count:originals.length,delete:release };
    }
    const originBox = keep(makeBox(oc, { dx, dy, dz }));
    const bounds = keep(transformShape(oc, originBox.shape, { ...IDENTITY_TRANSFORM, translation: box.minimum }));
    const argumentsList = keep(new oc.TopTools_ListOfShape_1()), tools = keep(new oc.TopTools_ListOfShape_1());
    keep(argumentsList.Append_1(target.shape)); keep(tools.Append_1(bounds.shape));
    const maker = keep(new oc.BRepAlgoAPI_Common_1()), progress = keep(new oc.Message_ProgressRange_1());
    maker.SetArguments(argumentsList); maker.SetTools(tools); maker.SetNonDestructive(true); maker.Build(progress);
    if (maker.HasErrors() || !maker.IsDone()) throw new Error('指定したXYZ範囲で関数の形を切り取れませんでした。');
    const common = keep(maker.Shape()), remaining = elements(oc, common, dimension, allocations);
    if (remaining.length === 0) { release(); return { status: 'empty' }; }
    const result = keep(makeCompound(oc, remaining));
    if (!isValidShape(oc, result.shape)) throw new Error('範囲で切り取った関数の形が正しくありません。');
    verifyFunctionShapeBounds(oc, result.shape, box, allocations);
    return { status: 'shape', shape: result.shape, count: remaining.length, delete: release };
  } catch (error) { release(); throw error; }
}
