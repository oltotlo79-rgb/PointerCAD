/** 周期スプラインの継ぎ目を含む積分だけ、節点区間を扱う方式へ送る。 */
import type { OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';

export function needsPeriodicVolumeIntegration(oc: OpenCascadeInstance, face: TopoDS_Face): boolean {
  const { keep, release } = createAllocations();
  try {
    const surface = keep(new oc.BRepAdaptor_Surface_2(face, false));
    const kind = surface.GetType();
    if (kind === oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface && (surface.IsUPeriodic() || surface.IsVPeriodic())) return true;
    if (kind === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion || kind === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfRevolution) {
      const basis = keep(surface.BasisCurve());
      if (basis.get().GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve && basis.get().IsPeriodic()) return true;
    }
    const edges = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(face, edges, true, true);
    for (let index = 1; index <= edges.Size(); index++) {
      const owned = createAllocations();
      try {
        const shape = owned.keep(edges.FindKey(index));
        if (shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
        const edge = owned.keep(oc.TopoDS.Edge_1(shape));
        const curve = owned.keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
        if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) {
          const spline = owned.keep(curve.BSpline());
          if (spline.get().IsPeriodic()) return true;
        }
      } finally { owned.release(); }
    }
    return false;
  } finally { release(); }
}
