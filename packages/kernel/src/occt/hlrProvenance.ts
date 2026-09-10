import type { HLRBRep_HLRToShape, HLRTopoBRep_OutLiner, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { HiddenLineCurve, HiddenLineMode, HiddenLineProvenance } from '../types.js';
import type { Allocations } from './allocations.js';
import { readSeamOutlines } from './hlrSeamOutlines.js';
import {
  makeProjection, orderPlaneCurves, planeBasisOf, projectEdgeToPlane,
  type PlaneCurve, type SketchPlaneFrame,
} from './makeProjection.js';

/** 精密・近似の両converterにある、元の辺/面に限定して結果を得る口。 */
export interface HlrConverter {
  VCompound_2(shape: TopoDS_Shape): TopoDS_Shape;
  HCompound_2(shape: TopoDS_Shape): TopoDS_Shape;
  OutLineVCompound_2(shape: TopoDS_Shape): TopoDS_Shape;
  OutLineHCompound_2(shape: TopoDS_Shape): TopoDS_Shape;
  CompoundOfEdges_2?: HLRBRep_HLRToShape['CompoundOfEdges_2'];
}

const XY_PLANE = { origin: [0, 0, 0], axisU: [1, 0, 0], normal: [0, 0, 1] } as const;

function read(oc: OpenCascadeInstance, shape: TopoDS_Shape): readonly PlaneCurve[] {
  return shape.IsNull() ? [] : makeProjection(oc, { source: shape, plane: XY_PLANE }).curves;
}

function interval(
  original: PlaneCurve | null,
  projected: PlaneCurve,
  first: number,
  last: number,
): readonly [number, number] | null {
  if (original?.kind === 'segment' && projected.kind === 'segment') {
    const dx = original.to[0] - original.from[0];
    const dy = original.to[1] - original.from[1];
    const square = dx * dx + dy * dy;
    if (square <= 1e-18) return null;
    const parameter = (point: readonly [number, number]): number => first + (last - first)
      * ((point[0] - original.from[0]) * dx + (point[1] - original.from[1]) * dy) / square;
    const a = parameter(projected.from); const b = parameter(projected.to);
    return [Math.max(first, Math.min(a, b)), Math.min(last, Math.max(a, b))];
  }
  if (original?.kind === 'arc' && projected.kind === 'arc') {
    const turn = Math.sign(original.endAngle - original.startAngle);
    const sweep = Math.abs(projected.endAngle - projected.startAngle);
    if (Math.abs(sweep - (last - first)) < 1e-8) return [first, last];
    const angle = turn === Math.sign(projected.endAngle - projected.startAngle)
      ? projected.startAngle : projected.endAngle;
    const delta = ((turn * (angle - original.startAngle)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    if (first + delta + sweep <= last + 1e-8) return [first + delta, Math.min(last, first + delta + sweep)];
  }
  return null;
}

/** 近似HLRが円を多数の線分として返した場合も、元辺ごとの折れ線へまとめる。 */
function polyCurves(curves: readonly PlaneCurve[], curvedEdge: boolean): readonly PlaneCurve[] {
  if (!curvedEdge) return curves;
  const result: PlaneCurve[] = [];
  let points: (readonly [number, number])[] = [];
  const flush = (): void => {
    if (points.length >= 2) {
      const start = points[0]; const end = points[points.length - 1];
      const closed = Math.hypot(start[0] - end[0], start[1] - end[1]) <= 1e-7;
      result.push({ kind: 'polyline', points: closed ? points.slice(0, -1) : points, closed });
    }
    points = [];
  };
  for (const curve of orderPlaneCurves(curves)) {
    if (curve.kind !== 'segment') { flush(); result.push(curve); continue; }
    const tail = points[points.length - 1];
    if (tail !== undefined && Math.hypot(tail[0] - curve.from[0], tail[1] - curve.from[1]) > 1e-7) flush();
    if (points.length === 0) points.push(curve.from);
    points.push(curve.to);
  }
  flush();
  return result;
}

/**
 * 元辺をconverterへ直接渡し、同じ2D位置へ重なる前後の辺も区別する。
 * 輪郭は元面へ問い合わせる。幾何が等しいという理由だけで元辺へ結び付けない。
 */
export function readHlrSource(
  oc: OpenCascadeInstance,
  converter: HlrConverter,
  source: { readonly shape: TopoDS_Shape; readonly referenceShape?: TopoDS_Shape; readonly bodyId: string; readonly occurrenceId?: string | null },
  plane: SketchPlaneFrame,
  mode: HiddenLineMode,
  includeHidden: boolean,
  allocations: Allocations,
  outliner?: HLRTopoBRep_OutLiner,
): { readonly visible: readonly HiddenLineCurve[]; readonly hidden: readonly HiddenLineCurve[] } {
  const { keep } = allocations;
  const basis = planeBasisOf(plane);
  const map = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(source.shape, map, true, true);
  const referenceMap = source.referenceShape === undefined ? null : keep(new oc.TopTools_IndexedMapOfShape_1());
  const referenceEdges = new Map<number, number>();
  if (referenceMap !== null && source.referenceShape !== undefined) {
    oc.TopExp.MapShapes_2(source.referenceShape, referenceMap, true, true);
    let originalIndex = 0;
    for (let index = 1; index <= Number(referenceMap.Size()); index++) {
      if (keep(referenceMap.FindKey(index)).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) referenceEdges.set(index, originalIndex++);
    }
  }
  const generatedShapes = new Map<number, TopoDS_Shape[]>();
  if (outliner !== undefined) {
    const history = keep(outliner.DataStructure());
    const outlined = keep(outliner.OutLinedShape_2());
    const generated = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(outlined, generated, true, true);
    for (let index = 1; index <= Number(generated.Size()); index += 1) {
      const shape = keep(generated.FindKey(index));
      const original = keep(history.NewSOldS(shape));
      const sourceIndex = Number(map.FindIndex(original));
      if (sourceIndex === 0) continue;
      const shapes = generatedShapes.get(sourceIndex) ?? [];
      shapes.push(shape); generatedShapes.set(sourceIndex, shapes);
    }
  }
  const visible: HiddenLineCurve[] = []; const hidden: HiddenLineCurve[] = [];
  let edgeIndex = 0; let faceIndex = 0;
  for (let index = 1; index <= Number(map.Size()); index += 1) {
    const shape = keep(map.FindKey(index));
    const isEdge = shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const isFace = shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE;
    if (!isEdge && !isFace) continue;
    const edge = isEdge ? keep(oc.TopoDS.Edge_1(shape)) : null;
    const originalEdgeIndex = referenceMap === null ? edgeIndex : referenceEdges.get(Number(referenceMap.FindIndex(shape)));
    // 球の極など、形状番号には含まれるが幾何曲線を持たない辺は投影しない。
    if (edge !== null && oc.BRep_Tool.Degenerated(edge)) { edgeIndex += 1; continue; }
    const adaptor = edge === null ? null : keep(new oc.BRepAdaptor_Curve_2(edge));
    const original = edge === null ? null : projectEdgeToPlane(oc, edge, basis, undefined, allocations);
    const curved = adaptor !== null && adaptor.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line;
    for (const isVisible of includeHidden ? [true, false] : [true]) {
      const projected = (generatedShapes.get(index) ?? [shape]).flatMap((generated) => {
        const output = keep(isEdge
          ? isVisible ? converter.VCompound_2(generated) : converter.HCompound_2(generated)
          : isVisible ? converter.OutLineVCompound_2(generated) : converter.OutLineHCompound_2(generated));
        return read(oc, output);
      });
      if (isFace && outliner !== undefined && converter.CompoundOfEdges_2 !== undefined) projected.push(...readSeamOutlines(oc,
        { CompoundOfEdges_2: converter.CompoundOfEdges_2.bind(converter) }, shape, generatedShapes.get(index) ?? [shape], plane, isVisible, allocations));
      const curves = mode === 'poly' ? polyCurves(projected, curved) : projected;
      for (const curve of curves) {
        const range = adaptor === null ? null : interval(original, curve, adaptor.FirstParameter(), adaptor.LastParameter());
        const provenance: HiddenLineProvenance = isEdge
          ? { kind: 'edge', bodyId: source.bodyId, occurrenceId: source.occurrenceId ?? null,
              edgeIndex: originalEdgeIndex ?? edgeIndex, parameterRange: range, dimensionTarget: range !== null && originalEdgeIndex !== undefined }
          : { kind: 'silhouette', bodyId: source.bodyId, occurrenceId: source.occurrenceId ?? null,
              faceIndex, generated: 'outline', dimensionTarget: false };
        (isVisible ? visible : hidden).push({ curve, provenance });
      }
    }
    if (isEdge) edgeIndex += 1;
    else faceIndex += 1;
  }
  return { visible, hidden };
}
