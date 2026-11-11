/** 形状検査と測定表示で体積の積分方式を共用する。 */
import type { GProp_GProps, OpenCascadeInstance, ShapeExtend_Status, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { ellipseExtrusionCentre } from './ellipseBoolean.js';
import { needsPeriodicVolumeIntegration } from './periodicVolumeFace.js';

/** embindの列挙型の不一致を、実際の登録値と数値の照合で扱う。 */
function isFailureStatus(value: unknown, registry: unknown): value is ShapeExtend_Status {
  return typeof registry === 'function' && 'ShapeExtend_FAIL' in registry && registry.ShapeExtend_FAIL === value
    && typeof value === 'object' && value !== null && value instanceof registry
    && 'value' in value && typeof value.value === 'number' && Number.isInteger(value.value);
}

function containsPeriodicFace(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const { keep, release } = createAllocations();
  try {
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, faces, true, true);
    for (let index = 1; index <= faces.Size(); index++) {
      const owned = createAllocations();
      try {
        const current = owned.keep(faces.FindKey(index));
        if (current.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const face = owned.keep(oc.TopoDS.Face_1(current));
        if (needsPeriodicVolumeIntegration(oc, face)) return true;
      } finally { owned.release(); }
    }
    return false;
  } finally { release(); }
}

/** 非周期スプラインの押出面。母線の節点区間を使う積分が必要な形だけを選ぶ。 */
function hasSplineExtrusion(oc: OpenCascadeInstance, shape: TopoDS_Shape, closedOnly = false): boolean {
  const { keep, release } = createAllocations();
  try {
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, faces, true, true);
    for (let index = 1; index <= faces.Size(); index++) {
      const owned = createAllocations();
      try {
        const current = owned.keep(faces.FindKey(index));
        if (current.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const face = owned.keep(oc.TopoDS.Face_1(current));
        const surface = owned.keep(new oc.BRepAdaptor_Surface_2(face, false));
        if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion) continue;
        const basis = owned.keep(surface.BasisCurve());
        if (basis.get().GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve && !basis.get().IsPeriodic()
          && (!closedOnly || basis.get().IsClosed())) return true;
      } finally { owned.release(); }
    }
    return false;
  } finally { release(); }
}


/** 円筒同士などの交線で切られた円筒面を、平面・円筒面だけの立体で検出する。 */
function hasCurvedCylinderBoundary(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const { keep, release } = createAllocations();
  let curved = false;
  try {
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, faces, true, true);
    for (let index = 1; index <= faces.Size(); index++) {
      const owned = createAllocations();
      try {
        const current = owned.keep(faces.FindKey(index));
        if (current.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const face = owned.keep(oc.TopoDS.Face_1(current));
        const surface = owned.keep(new oc.BRepAdaptor_Surface_2(face, false));
        const kind = surface.GetType();
        if (kind === oc.GeomAbs_SurfaceType.GeomAbs_Plane) continue;
        if (kind !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return false;
        if (curved) continue;
        const edges = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(face, edges, true, true);
        for (let edgeIndex = 1; edgeIndex <= edges.Size(); edgeIndex++) {
          const boundary = createAllocations();
          try {
            const item = boundary.keep(edges.FindKey(edgeIndex));
            if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
            const edge = boundary.keep(oc.TopoDS.Edge_1(item));
            const curve = boundary.keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
            if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) { curved = true; break; }
          } finally { boundary.release(); }
        }
      } finally { owned.release(); }
    }
    return curved;
  } finally { release(); }
}

/** 節点区間を使うGK積分。失敗値や非有限の体積は呼出し元へ返さない。 */
function computeGkProperties(oc: OpenCascadeInstance, shape: TopoDS_Shape, properties: GProp_GProps, massOnly: boolean): void {
  const error = oc.BRepGProp.VolumePropertiesGK_1(shape, properties, 1e-12, false, true, !massOnly, !massOnly, false);
  if (!Number.isFinite(error) || error < 0 || error > 1e-12 || !Number.isFinite(properties.Mass())) {
    throw new Error('立体の体積を必要な精度で計算できませんでした。');
  }
}

/** 周期曲線と閉じた非周期スプラインは測定用の写しだけを節点区間へ分ける。knownPlanarは認証済み直方体同士のCommon専用。
 * massOnlyは体積だけを読む内部caller専用。省略時は従来どおり重心と慣性も求める。 */
export function computeVolumeProperties(oc: OpenCascadeInstance, shape: TopoDS_Shape, properties: GProp_GProps, knownPlanar = false, massOnly = false): void {
  if (knownPlanar) {
    oc.BRepGProp.VolumeProperties_1(shape, properties, false, false, false);
    return;
  }
  const periodic = containsPeriodicFace(oc, shape);
  // 閉じた非周期母線は一枚の面のGK誤差見積りが不安定になるため、測定用コピーを分割する。
  const closedSpline = !periodic && hasSplineExtrusion(oc, shape, true);
  if (!periodic && !closedSpline) {
    if (ellipseExtrusionCentre(oc, shape) !== null || hasSplineExtrusion(oc, shape)) {
      computeGkProperties(oc, shape, properties, massOnly);
      return;
    }
    if (hasCurvedCylinderBoundary(oc, shape)) {
      // 円筒の曲線境界は固定次数では配置により誤差が変わる。同じ面を適応積分する。
      const error = oc.BRepGProp.VolumeProperties_2(shape, properties, 1e-9, false, false);
      if (!Number.isFinite(error) || error < 0 || error > 1e-9) {
        throw new Error('立体の体積を必要な精度で計算できませんでした。');
      }
    } else {
      oc.BRepGProp.VolumeProperties_1(shape, properties, false, false, false);
    }
    return;
  }
  const { keep, release } = createAllocations();
  try {
    const copier = keep(new oc.BRepBuilderAPI_Copy_2(shape, true, false));
    const copy = keep(copier.Shape());
    const converter = keep(new oc.ShapeUpgrade_ShapeConvertToBezier_2(copy));
    converter.Set2dConversion(false);
    converter.Set3dConversion(true);
    converter.SetSurfaceConversion(true);
    converter.Set3dLineConversion(false);
    converter.Set3dCircleConversion(false);
    converter.Set3dConicConversion(false);
    converter.SetPlaneMode(false);
    converter.SetRevolutionMode(false);
    converter.SetExtrusionMode(true);
    converter.SetBSplineMode(true);
    converter.Perform(true);
    const divided = keep(converter.Result());
    const failed = oc.ShapeExtend_Status.ShapeExtend_FAIL;
    if (!isFailureStatus(failed, oc.ShapeExtend_Status) || divided.IsNull() || converter.Status(failed)) {
      throw new Error('立体の体積を必要な精度で計算できませんでした。');
    }
    if (closedSpline) computeGkProperties(oc, divided, properties, massOnly);
    else oc.BRepGProp.VolumeProperties_1(divided, properties, false, false, false);
    if (!Number.isFinite(properties.Mass())) throw new Error('立体の体積を必要な精度で計算できませんでした。');
  } finally { release(); }
}
