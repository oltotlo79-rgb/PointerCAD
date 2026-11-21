import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from './allocations.js';
import type { FunctionSurfaceInput } from './functionSurfaceGeometrySpec.js';
import type { OcctShapeHandle } from './makeBox.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';

interface SurfaceBody {
  readonly shape: TopoDS_Shape;
  /** The input used to build this component, or an ordinary CAD surface. */
  readonly geometry: FunctionSurfaceInput | 'surface';
}

interface Thickness {
  readonly thickness: number;
  readonly side: 'normal' | 'reverse' | 'both';
}

/** 厚み付け・面全体のオフセットを作れなかった理由の符号。利用者へ見せる文は画面の側の一覧が持つ(ui/src/solid/surfaceBodyFailureText.ts。2026-11-20 の利用者の回答)。 */
type SurfaceThickenReason = 'faceted-function-surface' | 'invalid-surface-body' | 'invalid-thickness'
  | 'invalid-side' | 'invalid-offset-distance' | 'offset-failed' | 'invalid-offset-surface'
  | 'thicken-failed' | 'open-thick-solid' | 'invalid-thick-solid' | 'non-positive-volume';

export class SurfaceThickenError extends Error {
  constructor(readonly code: SurfaceThickenReason, options?: ErrorOptions) {
    super(code, options);
    this.name = 'SurfaceThickenError';
  }
}

function surfaceFaceCount(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  if (shape.IsNull()) return 0;
  const kind = shape.ShapeType();
  if (kind === oc.TopAbs_ShapeEnum.TopAbs_FACE) return 1;
  return kind === oc.TopAbs_ShapeEnum.TopAbs_SHELL ? shape.NbChildren() : 0;
}

function validSurface(oc: OpenCascadeInstance, shape: TopoDS_Shape, code: SurfaceThickenReason): number {
  const faces = surfaceFaceCount(oc, shape);
  if (!faces || !isValidShape(oc, shape)) throw new SurfaceThickenError(code);
  const area = measureArea(oc, shape);
  if (!Number.isFinite(area) || area <= 0) throw new SurfaceThickenError(code);
  return faces;
}

function copySurface(oc: OpenCascadeInstance, target: SurfaceBody, owner: Allocations): TopoDS_Shape {
  const { geometry, shape } = target;
  // The triangle builder can merge two triangles into one quadrilateral.
  if (geometry !== 'surface' && !('primitive' in geometry) && geometry.spline === undefined) {
    throw new SurfaceThickenError('faceted-function-surface');
  }
  validSurface(oc, shape, 'invalid-surface-body');
  const copy = owner.keep(new oc.BRepBuilderAPI_Copy_2(shape, true, false));
  if (!copy.IsDone()) throw new SurfaceThickenError('invalid-surface-body');
  return owner.keep(copy.Shape());
}

function offsetSurface(oc: OpenCascadeInstance, source: TopoDS_Shape, distance: number,
  owner: Allocations): TopoDS_Shape {
  if (!Number.isFinite(distance) || distance === 0) throw new SurfaceThickenError('invalid-offset-distance');
  const maker = owner.keep(new oc.BRepOffsetAPI_MakeOffsetShape());
  maker.PerformBySimple(source, distance);
  if (!maker.IsDone()) throw new SurfaceThickenError('offset-failed');
  const result = owner.keep(maker.Shape());
  if (validSurface(oc, result, 'invalid-offset-surface') !== surfaceFaceCount(oc, source)) {
    throw new SurfaceThickenError('invalid-offset-surface');
  }
  return result;
}

function checkSolid(oc: OpenCascadeInstance, shape: TopoDS_Shape, owner: Allocations): void {
  if (shape.IsNull() || shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
    throw new SurfaceThickenError('invalid-thick-solid');
  }
  const shells = owner.keep(new oc.TopoDS_Iterator_2(shape, true, true));
  if (!shells.More()) throw new SurfaceThickenError('open-thick-solid');
  for (; shells.More(); shells.Next()) {
    const shell = owner.keep(shells.Value());
    if (shell.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL || !oc.BRep_Tool.IsClosed_1(shell)) {
      throw new SurfaceThickenError('open-thick-solid');
    }
  }
  if (!isValidShape(oc, shape)) throw new SurfaceThickenError('invalid-thick-solid');
  const volume = measureVolume(oc, shape);
  if (!Number.isFinite(volume) || volume <= 0) throw new SurfaceThickenError('non-positive-volume');
}

function buildBody(code: SurfaceThickenReason, build: (owner: Allocations) => TopoDS_Shape): OcctShapeHandle {
  const owner = createAllocations();
  try {
    return { shape: build(owner), delete: owner.release };
  } catch (error) {
    owner.release();
    if (error instanceof SurfaceThickenError) throw error;
    throw new SurfaceThickenError(code, { cause: error });
  }
}

/** Signed distance in mm along the oriented surface normal. The source remains caller-owned. */
export function offsetSurfaceBody(oc: OpenCascadeInstance, target: SurfaceBody, distance: number): OcctShapeHandle {
  return buildBody('offset-failed', owner => offsetSurface(oc, copySurface(oc, target, owner), distance, owner));
}

/** The starting skin is an exterior boundary. Build towards its material side (negative normal). */
export function thickenSurfaceBody(oc: OpenCascadeInstance, target: SurfaceBody, input: Thickness): OcctShapeHandle {
  const { thickness, side } = input;
  if (!Number.isFinite(thickness) || thickness <= 0) throw new SurfaceThickenError('invalid-thickness');
  if (side !== 'normal' && side !== 'reverse' && side !== 'both') throw new SurfaceThickenError('invalid-side');
  return buildBody('thicken-failed', owner => {
    const source = copySurface(oc, target, owner);
    const start = side === 'both' ? offsetSurface(oc, source, -thickness / 2, owner) : source;
    // For +t along the source normal, the starting exterior skin points towards -n.
    const exterior = side === 'reverse' ? start : owner.keep(start.Reversed());
    const maker = owner.keep(new oc.BRepOffsetAPI_MakeThickSolid());
    maker.MakeThickSolidBySimple(exterior, -thickness);
    if (!maker.IsDone()) throw new SurfaceThickenError('thicken-failed');
    const result = owner.keep(maker.Shape());
    checkSolid(oc, result, owner);
    return result;
  });
}
