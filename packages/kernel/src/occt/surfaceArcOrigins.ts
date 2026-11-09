import type { BRepPrimAPI_MakePrism, OpenCascadeInstance, TopoDS_Edge, TopoDS_Shape,
  TopTools_ListOfShape } from 'opencascade.js/dist/opencascade.full.js';
import type { CurrentOriginIndex, FaceOrigin, OriginBinding, ShapeAddress } from '../subShapeOrigin.js';
import type { ArcSpec, CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { address, mapShape, type Maps } from './subShapeOrigins.js';
import { GEOMETRIC_CONFUSION_MM } from './tolerances.js';
import { crossVec as cross } from './sketchCorner.js';

type Anchor = Extract<FaceOrigin, { kind: 'surface-curve-side' }>['profile'];
const untracked = (): CurrentOriginIndex => ({ version: 1, state: 'untracked', reason: 'missing-native-map' });

/** Naming is narrower than geometry: one saved nonclosed arc in one canonical turn. */
export function surfaceArcAnchorValid(profile: readonly CurveSpec[], anchor: unknown): anchor is Anchor {
  if (anchor === undefined || anchor === null || typeof anchor !== 'object' || Array.isArray(anchor) || Reflect.ownKeys(anchor).map(String).sort().join(',') !== 'curveFeatureId,role,sketchId'
    || !('sketchId' in anchor) || !('curveFeatureId' in anchor) || !('role' in anchor)
    || typeof anchor.sketchId !== 'string' || anchor.sketchId.trim().length < 1 || anchor.sketchId.length > 256
    || typeof anchor.curveFeatureId !== 'string' || anchor.curveFeatureId.trim().length < 1 || anchor.curveFeatureId.length > 256
    || anchor.role !== 'whole-curve' || profile.length !== 1) return false;
  const arc = profile[0];
  return arc.kind === 'arc' && Number.isFinite(arc.startAngle) && Number.isFinite(arc.endAngle)
    && arc.startAngle >= 0 && arc.endAngle >= 0 && arc.startAngle < 2 * Math.PI && arc.endAngle < 2 * Math.PI
    && arc.startAngle !== arc.endAngle;
}

function generated(oc: OpenCascadeInstance, list: TopTools_ListOfShape, maps: Maps,
  kind: ShapeAddress['kind'], owned: Allocations): ShapeAddress | null {
  owned.keep(list);
  const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
  if (copy.Size() !== 1) return null;
  const shape = owned.keep(copy.First_1());
  const expected = kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE : oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  return shape.ShapeType() === expected ? address(maps, shape, kind) : null;
}

function unit(point: Vec3Tuple): Vec3Tuple | null {
  const norm = Math.hypot(...point);
  return Number.isFinite(norm) && norm > 0 ? [point[0] / norm, point[1] / norm, point[2] / norm] : null;
}

/** Coordinates only verify source endpoint roles, never constitute the saved identity. */
function endpoint(arc: ArcSpec, angle: number): Vec3Tuple | null {
  const normal = unit(arc.normal);
  if (normal === null) return null;
  const y = unit(cross(normal, arc.xAxis));
  if (y === null) return null;
  const x = cross(y, normal);
  const coordinate = (axis: 0 | 1 | 2): number => arc.center[axis] + arc.radius
    * (Math.cos(angle) * x[axis] + Math.sin(angle) * y[axis]);
  return [coordinate(0), coordinate(1), coordinate(2)];
}

/** Every address comes from this prism's history and must belong to its actual output. */
export function surfaceArcPrismOrigins(oc: OpenCascadeInstance, prism: BRepPrimAPI_MakePrism,
  wire: TopoDS_Shape, output: TopoDS_Shape, edge: TopoDS_Edge, arc: ArcSpec,
  anchor: Anchor, featureId: string): CurrentOriginIndex {
  if (!surfaceArcAnchorValid([arc], anchor) || featureId.length < 1 || featureId.length > 256) return untracked();
  const owned = createAllocations();
  try {
    const source = mapShape(oc, wire, owned), maps = mapShape(oc, output, owned);
    if (source.edge.Size() !== 1 || source.vertex.Size() !== 2 || source.edge.FindIndex(edge) < 1
      || maps.face.Size() !== 1 || maps.edge.Size() !== 4 || maps.vertex.Size() !== 4) return untracked();
    const start = owned.keep(oc.TopExp.FirstVertex(edge, true));
    const end = owned.keep(oc.TopExp.LastVertex(edge, true));
    const startAddress = address(source, start, 'vertex'), endAddress = address(source, end, 'vertex');
    if (startAddress === null || endAddress === null || startAddress.index === endAddress.index) return untracked();
    for (const [vertex, angle] of [[start, arc.startAngle], [end, arc.endAngle]] as const) {
      const expected = endpoint(arc, angle), actual = owned.keep(oc.BRep_Tool.Pnt(vertex));
      if (expected === null || Math.hypot(actual.X() - expected[0], actual.Y() - expected[1], actual.Z() - expected[2])
        > GEOMETRIC_CONFUSION_MM) return untracked();
    }
    const face = generated(oc, prism.Generated(edge), maps, 'face', owned);
    const first = owned.keep(prism.FirstShape_2(edge)), last = owned.keep(prism.LastShape_2(edge));
    if (first.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE || last.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) return untracked();
    const sectionStart = address(maps, first, 'edge');
    const sectionEnd = address(maps, last, 'edge');
    const sweptStart = generated(oc, prism.Generated(start), maps, 'edge', owned);
    const sweptEnd = generated(oc, prism.Generated(end), maps, 'edge', owned);
    if (face === null || sectionStart === null || sectionEnd === null || sweptStart === null || sweptEnd === null
      || new Set([sectionStart.index, sectionEnd.index, sweptStart.index, sweptEnd.index]).size !== 4) return untracked();
    const bindings: OriginBinding[] = [{ origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'surface-curve-side', featureId, profile: anchor } }, state: 'unique', current: face }];
    for (const [role, current] of [['section-start', sectionStart], ['section-end', sectionEnd],
      ['swept-start', sweptStart], ['swept-end', sweptEnd]] as const) {
      bindings.push({ origin: { version: 1, shapeKind: 'edge', identity: {
        kind: 'surface-curve-edge', featureId, profile: anchor, role } }, state: 'unique', current });
    }
    return { version: 1, state: 'tracked', bindings };
  } catch {
    return untracked();
  } finally { owned.release(); }
}
