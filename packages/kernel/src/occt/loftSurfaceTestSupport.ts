import type { BRepAdaptor_Surface, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, SubShapeQuery, ThruSectionsStepSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { extractEdges } from './extractEdges.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/** x=30t(1-t), y=30t²-20t³。直線x=0で閉じた面積は ∫x dy = 60 mm²。 */
export function splineSection(z: number, scale = 1, split = false): readonly CurveSpec[] {
  const polygons: readonly (readonly Vec3Tuple[])[] = split ? [
    [[0, 0, z], [5, 0, z], [7.5, 2.5, z], [7.5, 5, z]],
    [[7.5, 5, z], [7.5, 7.5, z], [5, 10, z], [0, 10, z]],
  ] : [[[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]]];
  return [...polygons.map((points): CurveSpec => ({ kind: 'spline', mode: 'control', closed: false,
    points: points.map(([x, y, height]): Vec3Tuple => [x * scale, y * scale, height]) })),
  { kind: 'segment', from: [0, 10 * scale, z], to: [0, 0, z] }];
}

export function splineLoft(overrides: Partial<ThruSectionsStepSpec> = {}): ThruSectionsStepSpec {
  return { kind: 'thruSections', ruled: false, smooth: false, closed: true, twist: 0, sphereSegments: 24,
    sections: [0, 100].map((z) => ({ kind: 'curves', curves: splineSection(z, z === 0 ? 1 : 2) })), ...overrides };
}

export function faceTables(oc: OpenCascadeInstance, shape: TopoDS_Shape) {
  const triangles = tessellate(oc, shape), lines = extractEdges(oc, shape);
  return collectSubShapes(oc, shape, triangles.faceRanges, lines.edgeRanges);
}

export function onlyFaceQuery(oc: OpenCascadeInstance, shape: TopoDS_Shape): Extract<SubShapeQuery, { kind: 'face' }> {
  const tables = faceTables(oc, shape);
  if (tables.faces.length !== 1) throw new Error('検査の前提: 面が1枚必要');
  const face = tables.faces[0];
  return { kind: 'face', index: face.index, surfaceKind: face.surfaceKind, area: face.area,
    position: face.centroid, axis: face.axis, radius: face.radius };
}

function normalAt(oc: OpenCascadeInstance, surface: BRepAdaptor_Surface, u: number, v: number, keep: Allocations['keep']): Vec3Tuple {
  const p = keep(new oc.gp_Pnt_1()), du = keep(new oc.gp_Vec_1()), dv = keep(new oc.gp_Vec_1());
  surface.D1(u, v, p, du, dv);
  const normal = keep(du.Crossed(dv)); normal.Normalize();
  return [normal.X(), normal.Y(), normal.Z()];
}

/** この4断面のロフトのz=20/60の両側で法線を測る。隣接する別の面へのG1の検査ではない。 */
export function sectionNormalAngles(oc: OpenCascadeInstance, shape: TopoDS_Shape, keep: Allocations['keep']): readonly number[] {
  const map = keep(new oc.TopTools_IndexedMapOfShape_1()); oc.TopExp.MapShapes_2(shape, map, true, true);
  const angles: number[] = [];
  for (let index = 1; index <= Number(map.Size()); index += 1) {
    const generic = keep(map.FindKey(index));
    if (generic.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
    const face = keep(oc.TopoDS.Face_1(generic)), surface = keep(new oc.BRepAdaptor_Surface_2(face, true));
    if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) continue;
    const u = (surface.FirstUParameter() + surface.LastUParameter()) / 2;
    const first = surface.FirstVParameter(), last = surface.LastVParameter();
    const start = keep(surface.Value(u, first)), end = keep(surface.Value(u, last));
    if (Math.abs(end.Z() - start.Z()) < 99) continue;
    for (const z of [20, 60]) {
      let lo = first, hi = last;
      for (let iteration = 0; iteration < 45; iteration += 1) {
        const v = (lo + hi) / 2, p = surface.Value(u, v);
        try { if ((p.Z() < z) === (end.Z() > start.Z())) lo = v; else hi = v; }
        finally { p.delete(); }
      }
      const v = (lo + hi) / 2, delta = (last - first) * 1e-6;
      const a = normalAt(oc, surface, u, v - delta, keep), b = normalAt(oc, surface, u, v + delta, keep);
      const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      angles.push(Math.atan2(Math.hypot(...cross), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * 180 / Math.PI);
    }
  }
  return angles;
}
