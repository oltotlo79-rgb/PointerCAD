import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { makeCut } from './makeCut.js';
import { makePlanarFace } from './makePlanarFace.js';
import type { PlaneCurve, SketchPlaneFrame } from './makeProjection.js';
import { makeProjection, planeBasisOf } from './makeProjection.js';
import { makeSection } from './makeSection.js';
import { measureArea, measureVolume } from './solidMesh.js';
import { boundingDiagonal } from './subShapes.js';

export const NO_SECTION_AT_POSITION_MESSAGE =
  'この位置では切り口ができません。切断線を動かしてください。';

export interface SectionShapeSpec {
  readonly target: TopoDS_Shape;
  readonly plane: SketchPlaneFrame;
  /** 線画を返す座標系。切断判定の平面とは分ける。 */
  readonly projectionPlane?: SketchPlaneFrame;
  readonly keepSide: 'positive' | 'negative';
  readonly kind?: 'full' | 'half' | 'local' | 'revolved' | 'stepped';
  readonly boundary?: readonly (readonly [number, number])[];
}

export interface CutFaceInfo {
  readonly index: number;
  readonly area: number;
  readonly point: Vec3Tuple;
  readonly normal: Vec3Tuple;
  readonly curves: readonly PlaneCurve[];
}

export type SectionShapeOutcome =
  | {
      readonly ok: true;
      readonly shape: TopoDS_Shape;
      readonly volume: number;
      readonly cutFaces: readonly CutFaceInfo[];
      readonly cutCurves: readonly PlaneCurve[];
      delete(): void;
    }
  | { readonly ok: false; readonly message: string };

const PLANE_TOLERANCE = 1e-7;

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function onCuttingPlane(
  point: Vec3Tuple,
  normal: Vec3Tuple,
  plane: ReturnType<typeof planeBasisOf>,
): boolean {
  const parallel = Math.abs(dot(normal, plane.normal));
  const offset: Vec3Tuple = [
    point[0] - plane.origin[0], point[1] - plane.origin[1], point[2] - plane.origin[2],
  ];
  return 1 - parallel <= PLANE_TOLERANCE && Math.abs(dot(offset, plane.normal)) <= PLANE_TOLERANCE;
}

/** `makeCut` の結果から、法線と1点が切断面に一致する平面だけを拾う。 */
function collectCutFaces(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  plane: ReturnType<typeof planeBasisOf>,
  projectionPlane: SketchPlaneFrame = plane,
): readonly CutFaceInfo[] {
  const allocations = createAllocations();
  const { keep, release } = allocations;
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const result: CutFaceInfo[] = [];
    let faceIndex = 0;
    for (let position = 1; position <= Number(map.Size()); position += 1) {
      const subShape = keep(map.FindKey(position));
      if (subShape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
      const face = keep(oc.TopoDS.Face_1(subShape));
      const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
      if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
        faceIndex += 1;
        continue;
      }
      const surface = keep(adaptor.Plane());
      const axis = keep(surface.Axis());
      const location = keep(axis.Location());
      const direction = keep(axis.Direction());
      const point: Vec3Tuple = [location.X(), location.Y(), location.Z()];
      const orientation = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      const oriented = (value: number): number => value === 0 ? 0 : value * orientation;
      // 幾何面の法線ではなく、残した立体から外へ向く面法線を使う。
      const normal: Vec3Tuple = [oriented(direction.X()), oriented(direction.Y()), oriented(direction.Z())];
      if (onCuttingPlane(point, normal, plane)) {
        // 面そのものの投影は外周だけになるため、compoundに包んで内側の穴の辺も含める。
        const compound = keep(new oc.TopoDS_Compound());
        const builder = keep(new oc.BRep_Builder());
        builder.MakeCompound(compound); builder.Add(compound, face);
        result.push({ index: faceIndex, area: measureArea(oc, face), point, normal,
          curves: makeProjection(oc, { source: compound, plane: projectionPlane }).curves });
      }
      faceIndex += 1;
    }
    return result;
  } finally {
    release();
  }
}

/**
 * 交線を先に確かめ、半空間で切った形と切り口を返す。交線だけを断面図の線画にはしない。
 * 入力 shape は借用し、成功結果だけが新しい shape を所有する。
 */
export function makeSectionShape(
  oc: OpenCascadeInstance,
  spec: SectionShapeSpec,
): SectionShapeOutcome {
  let cut: ReturnType<typeof makeCut> | null = null;
  try {
    const basis = planeBasisOf(spec.plane);
    let cuttingPlanes = [basis];
    if (spec.kind === 'stepped') {
      const stepped = steppedSection(oc, spec, basis);
      cut = stepped.cut; cuttingPlanes = stepped.planes;
    } else {
      const section = makeSection(oc, { target: spec.target, plane: spec.plane });
      if (section.curves.length === 0) return { ok: false, message: NO_SECTION_AT_POSITION_MESSAGE };
      cut = makeCut(oc, spec.target, {
        origin: basis.origin,
        normal: basis.normal,
        keepPositive: spec.keepSide === 'positive',
      });
    }
    if (spec.kind === 'half' || spec.kind === 'local') {
      const replaced = restrictSection(oc, spec, basis);
      cut.delete();
      cut = replaced;
    }
    const retained = cut.shape;
    const cutFaces = cuttingPlanes.flatMap((plane) => collectCutFaces(oc, retained, plane, spec.projectionPlane ?? basis))
      .filter((face, index, all) => all.findIndex((candidate) => candidate.index === face.index) === index);
    if (cutFaces.length === 0) {
      cut.delete();
      return { ok: false, message: NO_SECTION_AT_POSITION_MESSAGE };
    }
    const owned = cut;
    return {
      ok: true,
      shape: owned.shape,
      volume: measureVolume(oc, owned.shape),
      cutFaces,
      cutCurves: cutFaces.flatMap((face) => face.curves),
      delete: () => owned.delete(),
    };
  } catch {
    cut?.delete();
    return { ok: false, message: NO_SECTION_AT_POSITION_MESSAGE };
  }
}

/** 段付きの境界は(u, 深さ)の折れ線。v方向へ押し出した除去工具を一度だけ差し引く。 */
function steppedSection(
  oc: OpenCascadeInstance,
  spec: SectionShapeSpec,
  basis: ReturnType<typeof planeBasisOf>,
): { readonly cut: ReturnType<typeof makeCut>; readonly planes: ReturnType<typeof planeBasisOf>[] } {
  const allocations = createAllocations(); const { keep } = allocations;
  try {
    const boundary = spec.boundary ?? [];
    if (boundary.length < 2 || boundary.some((point, index) => !point.every(Number.isFinite)
      || (index > 0 && point[0] < boundary[index - 1][0]))) throw new Error(NO_SECTION_AT_POSITION_MESSAGE);
    const bounds = keep(new oc.Bnd_Box_1()); oc.BRepBndLib.Add(spec.target, bounds, false);
    const low = keep(bounds.CornerMin()); const high = keep(bounds.CornerMax());
    const extent = 2 * Math.max(
      Math.hypot(low.X() - basis.origin[0], low.Y() - basis.origin[1], low.Z() - basis.origin[2]),
      Math.hypot(high.X() - basis.origin[0], high.Y() - basis.origin[1], high.Z() - basis.origin[2]),
      ...boundary.flat().map(Math.abs), 1,
    );
    const first = boundary[0]; const last = boundary[boundary.length - 1];
    const profile: (readonly [number, number])[] = [[-extent, first[1]], ...boundary, [extent, last[1]]];
    const at = ([u, depth]: readonly [number, number], v: number): Vec3Tuple => [
      basis.origin[0] + u * basis.axisU[0] + depth * basis.normal[0] + v * basis.axisV[0],
      basis.origin[1] + u * basis.axisU[1] + depth * basis.normal[1] + v * basis.axisV[1],
      basis.origin[2] + u * basis.axisU[2] + depth * basis.normal[2] + v * basis.axisV[2],
    ];
    const removedDepth = spec.keepSide === 'positive' ? -extent : extent;
    const polygon = [...profile, [extent, removedDepth] as const, [-extent, removedDepth] as const];
    const face = keep(makePlanarFace(oc, polygon.map((point, index) => ({
      kind: 'segment', from: at(point, -extent), to: at(polygon[(index + 1) % polygon.length], -extent),
    }))));
    const vector = keep(new oc.gp_Vec_4(basis.axisV[0] * 2 * extent, basis.axisV[1] * 2 * extent, basis.axisV[2] * 2 * extent));
    const maker = keep(new oc.BRepPrimAPI_MakePrism_1(face.face, vector, true, true));
    const tool = keep(maker.Shape());
    const planes = profile.slice(0, -1).map((point, index) => {
      const next = profile[index + 1]; const du = next[0] - point[0]; const depth = next[1] - point[1];
      return planeBasisOf({ origin: at(point, 0), axisU: basis.axisV, normal: [
        du * basis.normal[0] - depth * basis.axisU[0],
        du * basis.normal[1] - depth * basis.axisU[1],
        du * basis.normal[2] - depth * basis.axisU[2],
      ] });
    });
    return { cut: booleanOp(oc, 'subtract', spec.target, tool), planes };
  } finally { allocations.release(); }
}

/** 指定範囲の手前だけを取り去る。残す半空間と未切断部を混同しない。 */
function restrictSection(
  oc: OpenCascadeInstance,
  spec: SectionShapeSpec,
  basis: ReturnType<typeof planeBasisOf>,
): ReturnType<typeof makeCut> {
  const allocations = createAllocations();
  const { keep } = allocations;
  try {
    const removed = keep(makeCut(oc, spec.target, {
      origin: basis.origin, normal: basis.normal, keepPositive: spec.keepSide === 'negative',
    }));
    const boundary = spec.boundary ?? [];
    const pointAt = ([u, v]: readonly [number, number]): Vec3Tuple => [
      basis.origin[0] + u * basis.axisU[0] + v * basis.axisV[0],
      basis.origin[1] + u * basis.axisU[1] + v * basis.axisV[1],
      basis.origin[2] + u * basis.axisU[2] + v * basis.axisV[2],
    ];
    let limited: TopoDS_Shape;
    if (spec.kind === 'half') {
      if (boundary.length !== 2) throw new Error(NO_SECTION_AT_POSITION_MESSAGE);
      const a = boundary[0]; const b = boundary[1];
      const du = b[0] - a[0]; const dv = b[1] - a[1];
      const normal: Vec3Tuple = [
        -dv * basis.axisU[0] + du * basis.axisV[0],
        -dv * basis.axisU[1] + du * basis.axisV[1],
        -dv * basis.axisU[2] + du * basis.axisV[2],
      ];
      limited = keep(makeCut(oc, removed.shape, { origin: pointAt(a), normal, keepPositive: true })).shape;
    } else {
      if (boundary.length < 3) throw new Error(NO_SECTION_AT_POSITION_MESSAGE);
      const face = keep(makePlanarFace(oc, boundary.map((point, index) => ({
        kind: 'segment', from: pointAt(point), to: pointAt(boundary[(index + 1) % boundary.length]),
      }))));
      const extent = Math.max(1, boundingDiagonal(oc, spec.target) * 2);
      const direction = spec.keepSide === 'positive' ? -extent : extent;
      const vector = keep(new oc.gp_Vec_4(basis.normal[0] * direction, basis.normal[1] * direction, basis.normal[2] * direction));
      const maker = keep(new oc.BRepPrimAPI_MakePrism_1(face.face, vector, true, true));
      const prism = keep(maker.Shape());
      limited = keep(booleanOp(oc, 'intersect', removed.shape, prism)).shape;
    }
    return booleanOp(oc, 'subtract', spec.target, limited);
  } finally { allocations.release(); }
}
