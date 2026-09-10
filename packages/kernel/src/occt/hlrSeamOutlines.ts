import type { HLRBRep_HLRToShape, HLRBRep_TypeOfResultingEdge, OpenCascadeInstance, TopoDS_Edge, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from './allocations.js';
import { distanceBetween } from './measureShape.js';
import { makeProjection, type PlaneCurve, type SketchPlaneFrame } from './makeProjection.js';

/** P8 §4/7.3の2026-09-10訂正で、このAPI一箇所だけに限定したbindingの検証。 */
export function isHlrOutlineKind(value: unknown, registry: unknown): value is HLRBRep_TypeOfResultingEdge {
  return typeof registry === 'function' && 'HLRBRep_OutLine' in registry && registry.HLRBRep_OutLine === value
    && typeof value === 'object' && value !== null && value instanceof registry && 'value' in value && value.value === 2
    && typeof value.constructor === 'function' && value.constructor.name === 'HLRBRep_TypeOfResultingEdge_HLRBRep_OutLine';
}

/** 継ぎ目を実稜線扱いせず、同じ元面に属する3D輪郭から取り出す。 */
export function readSeamOutlines(oc: OpenCascadeInstance, converter: Pick<HLRBRep_HLRToShape, 'CompoundOfEdges_2'>,
  faceShape: TopoDS_Shape, generated: readonly TopoDS_Shape[], plane: SketchPlaneFrame, visible: boolean,
  allocations: Allocations): readonly PlaneCurve[] {
  const { keep } = allocations, face = keep(oc.TopoDS.Face_1(faceShape));
  const map = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(face, map, true, true);
  const seams: TopoDS_Edge[] = [];
  for (let index = 1; index <= Number(map.Size()); index++) {
    const shape = keep(map.FindKey(index));
    if (shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
    const edge = keep(oc.TopoDS.Edge_1(shape));
    if (!oc.BRep_Tool.Degenerated(edge) && oc.BRep_Tool.IsClosed_2(edge, face)) seams.push(edge);
  }
  if (seams.length === 0) return [];
  const outlineKind: unknown = oc.HLRBRep_TypeOfResultingEdge.HLRBRep_OutLine;
  if (!isHlrOutlineKind(outlineKind, oc.HLRBRep_TypeOfResultingEdge)) throw new Error('OCCTの輪郭列挙を確認できませんでした。');
  const result: PlaneCurve[] = [];
  for (const shape of generated) {
    // 2D抽出はInternalだけ、3D抽出はOutLineも含む（OCCT HLRBRep_HLRToShape::DrawFace）。
    const output = keep(converter.CompoundOfEdges_2(shape, outlineKind, visible, true));
    if (output.IsNull()) continue;
    const edges = keep(new oc.TopTools_IndexedMapOfShape_1()); oc.TopExp.MapShapes_2(output, edges, true, true);
    for (let index = 1; index <= Number(edges.Size()); index++) {
      const item = keep(edges.FindKey(index));
      if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
      const edge = keep(oc.TopoDS.Edge_1(item));
      // 投影後の座標一致では手前・奥を区別できない。3Dで元の継ぎ目上にあることを調べる。
      if (seams.some((seam) => onSeam(oc, edge, seam))) result.push(...makeProjection(oc, { source: edge, plane }).curves);
    }
  }
  return result;
}

function onSeam(oc: OpenCascadeInstance, edge: TopoDS_Edge, seam: TopoDS_Edge): boolean {
  const owned = createAllocations(), { keep } = owned;
  try {
    const curve = keep(new oc.BRepAdaptor_Curve_2(edge)), first = curve.FirstParameter(), last = curve.LastParameter();
    if (![first, last].every(Number.isFinite) || last <= first) return false;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const point = keep(curve.Value(first + (last - first) * t));
      const maker = keep(new oc.BRepBuilderAPI_MakeVertex(point)), vertex = keep(maker.Shape());
      if (distanceBetween(oc, vertex, seam).distance > 1e-7) return false;
    }
    return true;
  } finally { owned.release(); }
}
