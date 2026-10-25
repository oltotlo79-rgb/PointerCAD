import type { BRepAlgoAPI_BooleanOperation, BRepBuilderAPI_Transform, OpenCascadeInstance,
  TopoDS_Shape, TopTools_ListOfShape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from './allocations.js';

/** The observer consumes correspondence, not the mutable native builder. */
export type BooleanHistory = Pick<BRepAlgoAPI_BooleanOperation, 'Modified' | 'Generated' | 'IsDeleted' | 'IsDone'>;

/** Analytic elliptical extrusion only; periodic spline integration retains its existing path. */
export function ellipseExtrusionCentre(oc: OpenCascadeInstance, shape: TopoDS_Shape, conditioning = false): readonly [number, number, number] | null {
  const owned = createAllocations();
  try {
    const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    for (let index = 1; index <= map.Size(); index++) {
      const item = owned.keep(map.FindKey(index));
      if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
      const face = owned.keep(oc.TopoDS.Face_1(item));
      const surface = owned.keep(new oc.BRepAdaptor_Surface_2(face, false));
      if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion) continue;
      const basis = owned.keep(surface.BasisCurve());
      if (basis.get().GetType() !== oc.GeomAbs_CurveType.GeomAbs_Ellipse) continue;
      const ellipse = owned.keep(basis.get().Ellipse());
      if (conditioning && (!Number.isFinite(ellipse.MinorRadius()) || ellipse.MinorRadius() < 1e-4
        || !Number.isFinite(ellipse.MajorRadius()) || ellipse.MajorRadius() > 1e4)) return null;
      const centre = owned.keep(ellipse.Location());
      return [centre.X(), centre.Y(), centre.Z()];
    }
    return null;
  } finally { owned.release(); }
}

export interface EllipseConditioning {
  readonly inputs: readonly TopoDS_Shape[];
  finish(maker: BRepAlgoAPI_BooleanOperation, output: TopoDS_Shape): {
    readonly shape: TopoDS_Shape; readonly history: BooleanHistory;
  };
}

/**
 * OCCT 7.6.2 fixes the intersection approximation at 1e-7 model units. A power-of-two
 * change of units resolves it more finely in physical coordinates. Existing BRep
 * tolerances are transformed by OCCT and restored by the inverse; none are reset.
 * This is conditioning, not a certified error bound. Analytic regressions remain decisive.
 */
export function conditionEllipseBoolean(oc: OpenCascadeInstance, inputs: readonly TopoDS_Shape[],
  owned: Allocations): EllipseConditioning | null {
  const centre = inputs.map(input => ellipseExtrusionCentre(oc, input, true)).find(value => value !== null);
  if (centre === undefined || centre === null || !centre.every(Number.isFinite)) return null;
  const temporary = createAllocations();
  const scale = 4096;
  try {
    const box = temporary.keep(new oc.Bnd_Box_1());
    for (const input of inputs) oc.BRepBndLib.AddOptimal(input, box, false, true);
    if (box.IsVoid() || box.IsOpen()) return null;
    const low = temporary.keep(box.CornerMin()), high = temporary.keep(box.CornerMax());
    const bounds = [low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z()];
    if (!bounds.every(Number.isFinite) || bounds.some((value, index) => Math.abs(value - centre[index % 3]) * scale > 1e8)) return null;
    // Do not condition sub-confusion-size inputs or erase a large-coordinate placement.
    if (Math.max(high.X() - low.X(), high.Y() - low.Y(), high.Z() - low.Z()) < 1e-4
      || centre.some(value => Math.abs(value) > 1e9)) return null;
  } finally { temporary.release(); }
  const transform = owned.keep(new oc.gp_Trsf_1());
  transform.SetValues(scale, 0, 0, -scale * centre[0], 0, scale, 0, -scale * centre[1], 0, 0, scale, -scale * centre[2]);
  const inverse = owned.keep(transform.Inverted());
  const transforms: BRepBuilderAPI_Transform[] = [];
  const memberMaps = inputs.map(input => {
    const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(input, map, true, true);
    return map;
  });
  const moved = inputs.map(input => {
    const builder = owned.keep(new oc.BRepBuilderAPI_Transform_2(input, transform, true));
    transforms.push(builder);
    return owned.keep(builder.Shape());
  });
  return { inputs: moved, finish(maker, output) {
    const restore = owned.keep(new oc.BRepBuilderAPI_Transform_2(output, inverse, true));
    const shape = owned.keep(restore.Shape());
    const outputMap = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(output, outputMap, true, true);
    const movedSource = (source: TopoDS_Shape): TopoDS_Shape => {
      const index = memberMaps.findIndex(map => map.Contains(source));
      const builder = transforms[index];
      if (builder === undefined) throw new Error('Conditioned Boolean history source is not an input');
      return owned.keep(builder.ModifiedShape(source));
    };
    const mappedList = (source: TopoDS_Shape, generated: boolean): TopTools_ListOfShape => {
      const local = createAllocations();
      const result = new oc.TopTools_ListOfShape_1();
      try {
        const movedItem = movedSource(source);
        const native = local.keep(generated ? maker.Generated(movedItem) : maker.Modified(movedItem));
        const copy = local.keep(new oc.TopTools_ListOfShape_3(native));
        while (copy.Size() > 0) {
          const item = local.keep(copy.First_1());
          const final = local.keep(restore.ModifiedShape(item));
          local.keep(result.Append_1(final));
          copy.RemoveFirst();
        }
        // A shape unchanged by the Boolean is still modified by the coordinate transforms.
        if (!generated && native.Size() === 0 && outputMap.Contains(movedItem)) {
          const final = local.keep(restore.ModifiedShape(movedItem));
          local.keep(result.Append_1(final));
        }
        return result;
      } catch (error) { result.delete(); throw error; }
      finally { local.release(); }
    };
    return { shape, history: {
      IsDone: () => maker.IsDone(),
      Modified: source => mappedList(source, false),
      Generated: source => mappedList(source, true),
      IsDeleted: source => maker.IsDeleted(movedSource(source)),
    } };
  } };
}
