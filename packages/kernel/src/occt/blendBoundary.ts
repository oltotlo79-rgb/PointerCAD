import type { BRepAdaptor_Curve, BRepAdaptor_Curve2d, gp_Pnt, gp_Vec, OpenCascadeInstance, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { SubShapeQuery, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { resolveEdgeReference } from './matchSubShape.js';
import { unitDirection } from './normalizeDirection.js';
import { MISSING_SUB_SHAPE_MESSAGE } from './pickSubShape.js';
import { crossVec, scaleVec } from './sketchCorner.js';
import { boundingDiagonal, edgeAt, faceAt, facesTouchingEdge, type SubShapeTables } from './subShapes.js';

export interface BlendEdgeSource {
  readonly shape: TopoDS_Shape;
  readonly tables: SubShapeTables;
  readonly query: Extract<SubShapeQuery, { kind: 'edge' }>;
}

/** つなぎ面を作れなかった理由の符号。利用者へ見せる文は画面の側の一覧が持つ(ui/src/solid/surfaceBodyFailureText.ts。2026-11-20 の利用者の回答)。 */
export class BlendSurfaceError extends Error {
  constructor(readonly code: 'boundary-required' | 'no-tangent' | 'blend-failed' | 'invalid-blend-face', options?: ErrorOptions) {
    super(code, options);
    this.name = 'BlendSurfaceError';
  }
}

function orientation(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const value = shape.Orientation_1();
  if (value === oc.TopAbs_Orientation.TopAbs_FORWARD) return 1;
  if (value === oc.TopAbs_Orientation.TopAbs_REVERSED) return -1;
  throw new BlendSurfaceError('boundary-required');
}

function forEachChild(oc: OpenCascadeInstance, parent: TopoDS_Shape, visit: (item: TopoDS_Shape) => void): void {
  const items = new oc.TopoDS_Iterator_2(parent, true, true);
  try {
    for (; items.More(); items.Next()) {
      const item = items.Value();
      try { visit(item); } finally { item.delete(); }
    }
  } finally { items.delete(); }
}

/** Count boundary wire occurrences. The edge and face orientations cancel when the whole face is reversed. */
function boundarySign(oc: OpenCascadeInstance, face: TopoDS_Face, edge: TopoDS_Edge): number {
  let sign = 0;
  forEachChild(oc, face, wire => {
    if (wire.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_WIRE) return;
    forEachChild(oc, wire, member => {
      if (!member.IsSame(edge)) return;
      if (sign !== 0) throw new BlendSurfaceError('boundary-required');
      sign = orientation(oc, member) * orientation(oc, face);
    });
  });
  if (sign === 0) throw new BlendSurfaceError('boundary-required');
  return sign;
}

function supportingBoundary(oc: OpenCascadeInstance, source: BlendEdgeSource, owner: Allocations) {
  const { shape, tables, query } = source;
  const resolved = resolveEdgeReference(tables.edges, query, boundingDiagonal(oc, shape) * 0.5, tables.origins);
  if (resolved.status !== 'matched') throw new Error(MISSING_SUB_SHAPE_MESSAGE);
  const index = resolved.match.index;
  const touching = facesTouchingEdge(oc, shape, index);
  if (touching.length !== 1) throw new BlendSurfaceError('boundary-required');
  const face = faceAt(oc, shape, touching[0]);
  if (face === null) throw new BlendSurfaceError('boundary-required');
  owner.keep(face);
  const edge = edgeAt(oc, shape, index);
  if (edge === null) throw new Error(MISSING_SUB_SHAPE_MESSAGE);
  owner.keep(edge);
  if (oc.BRep_Tool.IsClosed_2(edge, face)) throw new BlendSurfaceError('boundary-required');
  if (oc.BRep_Tool.Degenerated(edge) || !oc.BRep_Tool.SameParameter(edge) || !oc.BRep_Tool.SameRange(edge)) {
    throw new BlendSurfaceError('no-tangent');
  }
  return { face, edge, sign: boundarySign(oc, face, edge) };
}

function xyz(value: gp_Pnt | gp_Vec): Vec3Tuple {
  return [value.X(), value.Y(), value.Z()];
}

function direction(value: Vec3Tuple): Vec3Tuple {
  const unit = unitDirection(value);
  if (unit === null) throw new BlendSurfaceError('no-tangent');
  return unit;
}

function interiorKnots(oc: OpenCascadeInstance, curve: BRepAdaptor_Curve | BRepAdaptor_Curve2d, owner: Allocations): number[] {
  if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) return [];
  const spline = owner.keep(curve.BSpline()).get();
  const first = curve.FirstParameter(), last = curve.LastParameter();
  const knots: number[] = [];
  const count = Number(spline.NbKnots());
  for (let i = 1; i <= count; i++) {
    const t = spline.Knot(i);
    if (t > first && t < last) knots.push((t - first) / (last - first));
  }
  return knots;
}

/** U always follows the native 3D curve as in the saved edge fingerprint.
 * The boundary traversal is used only to choose the outward (A) or inward (B) tangent. */
export function readBlendBoundary(oc: OpenCascadeInstance, source: BlendEdgeSource, side: 'a' | 'b', owner: Allocations) {
  const { edge, face, sign } = supportingBoundary(oc, source, owner);
  try {
    const curve = owner.keep(new oc.BRepAdaptor_Curve_2(edge));
    const pcurve = owner.keep(new oc.BRepAdaptor_Curve2d_2(edge, face));
    const surface = owner.keep(new oc.BRepAdaptor_Surface_2(face, false));
    const first = curve.FirstParameter(), last = curve.LastParameter();
    if (!(last > first) || !Number.isFinite(last - first) || !curve.Is3DCurve()
      || first !== pcurve.FirstParameter() || last !== pcurve.LastParameter()) throw new BlendSurfaceError('no-tangent');
    const uv = owner.keep(new oc.gp_Pnt2d_1());
    const point = owner.keep(new oc.gp_Pnt_1()), onFace = owner.keep(new oc.gp_Pnt_1());
    const along = owner.keep(new oc.gp_Vec_1());
    const du = owner.keep(new oc.gp_Vec_1()), dv = owner.keep(new oc.gp_Vec_1());
    const evaluate = (u: number) => {
      const t = u === 1 ? last : first + (last - first) * u;
      try {
        curve.D1(t, point, along);
        pcurve.D0(t, uv);
        surface.D1(uv.X(), uv.Y(), onFace, du, dv);
        const normal = direction(crossVec(direction(xyz(du)), direction(xyz(dv))));
        const outward = direction(crossVec(direction(xyz(along)), normal));
        const tangent = scaleVec(outward, side === 'a' ? sign : -sign);
        return { point: xyz(point), tangent, support: { point: xyz(onFace), normal } };
      } catch (cause) { throw new BlendSurfaceError('no-tangent', { cause }); }
    };
    return { edge, evaluate, knots: [...interiorKnots(oc, curve, owner), ...interiorKnots(oc, pcurve, owner)] };
  } catch (cause) { throw new BlendSurfaceError('no-tangent', { cause }); }
}
