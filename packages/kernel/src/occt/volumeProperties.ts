/** 形状検査と測定表示で体積の積分方式を共用する。 */
import type { GProp_GProps, OpenCascadeInstance, ShapeExtend_Status, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
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

/** 周期曲線は測定用の写しだけを節点区間へ分ける。knownPlanarは認証済み直方体同士のCommon専用。 */
export function computeVolumeProperties(oc: OpenCascadeInstance, shape: TopoDS_Shape, properties: GProp_GProps, knownPlanar = false): void {
  if (knownPlanar || !containsPeriodicFace(oc, shape)) {
    oc.BRepGProp.VolumeProperties_1(shape, properties, false, false, false);
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
    oc.BRepGProp.VolumeProperties_1(divided, properties, false, false, false);
    if (!Number.isFinite(properties.Mass())) throw new Error('立体の体積を必要な精度で計算できませんでした。');
  } finally { release(); }
}
