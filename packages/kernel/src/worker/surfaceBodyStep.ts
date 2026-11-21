import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from '../occt/allocations.js';
import type { FunctionSurfaceInput } from '../occt/functionSurfaceGeometrySpec.js';
import type { OcctShapeHandle } from '../occt/makeBox.js';
import { offsetSurfaceBody, SurfaceThickenError, thickenSurfaceBody } from '../occt/makeSurfaceThicken.js';
import { makeCompound } from '../occt/transformShape.js';
import type { OffsetSurfaceBodyStepSpec, SolidStepSpec, ThickenStepSpec } from '../types.js';
import type { CachedSolid } from './recomputeSolids.js';
import type { ShapeCache } from './shapeCache.js';

/** Keep the construction route across cache hits, face extraction and transformations. */
export function sourceSurfaceGeometry(spec: SolidStepSpec, cache: ShapeCache<CachedSolid>): FunctionSurfaceInput | undefined {
  switch (spec.kind) {
    case 'functionSurface': return spec.geometry;
    case 'surface': return spec.targetKey === null ? undefined : cache.get(spec.targetKey)?.surfaceGeometry;
    case 'offsetBody': case 'mirror': case 'transform': case 'scale':
      return cache.get(spec.targetKey)?.surfaceGeometry;
    case 'sew': {
      if (!('faces' in spec)) return undefined;
      let smooth: FunctionSurfaceInput | undefined;
      for (const { targetKey } of spec.faces) {
        const input = cache.get(targetKey)?.surfaceGeometry;
        if (input === undefined) continue;
        if (!('primitive' in input) && input.spline === undefined) return input;
        smooth = input;
      }
      return smooth;
    }
    default: return undefined;
  }
}

/** The history selects the whole body. Keep shell boundaries and process every disjoint component. */
function surfaceComponents(oc: OpenCascadeInstance, shape: TopoDS_Shape, owner: Allocations): TopoDS_Shape[] {
  const pending = [shape], components: TopoDS_Shape[] = [];
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined || item.IsNull()) throw new SurfaceThickenError('invalid-surface-body');
    const kind = item.ShapeType();
    if (kind === oc.TopAbs_ShapeEnum.TopAbs_FACE || kind === oc.TopAbs_ShapeEnum.TopAbs_SHELL) {
      components.push(item);
      continue;
    }
    if (kind !== oc.TopAbs_ShapeEnum.TopAbs_COMPOUND || item.NbChildren() === 0) {
      throw new SurfaceThickenError('invalid-surface-body');
    }
    const children = owner.keep(new oc.TopoDS_Iterator_2(item, true, true));
    const parts: TopoDS_Shape[] = [];
    for (; children.More(); children.Next()) parts.push(owner.keep(children.Value()));
    for (let index = parts.length - 1; index >= 0; index--) pending.push(parts[index]);
  }
  return components;
}

export function makeSurfaceBodyStep(oc: OpenCascadeInstance, target: CachedSolid,
  spec: ThickenStepSpec | OffsetSurfaceBodyStepSpec): OcctShapeHandle {
  if (target.mesh.bodyKind !== 'shell') throw new SurfaceThickenError('invalid-surface-body');
  const owner = createAllocations();
  try {
    const geometry = target.surfaceGeometry ?? 'surface';
    const shapes = surfaceComponents(oc, target.shape, owner).map(shape => {
      const result = spec.kind === 'thicken' ? thickenSurfaceBody(oc, { shape, geometry }, spec)
        : offsetSurfaceBody(oc, { shape, geometry }, spec.distance);
      return owner.keep(result).shape;
    });
    const shape = shapes.length === 1 ? shapes[0] : owner.keep(makeCompound(oc, shapes)).shape;
    return { shape, delete: owner.release };
  } catch (error) {
    owner.release();
    throw error;
  }
}
