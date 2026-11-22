import { beforeAll, describe, expect, it } from 'vitest';
import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { HoleStepSpec, SolidEdgeInfo, SolidFaceInfo, SubShapeQuery, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { edgeDistanceCenters } from './edgeDistancePlacement.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeHole, resolveHoleFrame } from './makeHole.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { transformShape } from './transformShape.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 辺からの距離の穴(M-02)。期待の中心は、製品の式を使わずに板の寸法から手で出す。 */
describe('辺からの距離で置く穴の中心(M-02)', () => {
  let oc: Occt;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  function tables(shape: TopoDS_Shape): { readonly faces: readonly SolidFaceInfo[]; readonly edges: readonly SolidEdgeInfo[] } {
    const mesh = tessellate(oc, shape), lines = extractEdges(oc, shape);
    const collected = collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
    return { faces: collected.faces, edges: collected.edges };
  }
  const faceQuery = (face: SolidFaceInfo): SubShapeQuery => ({ kind: 'face', index: face.index, surfaceKind: face.surfaceKind,
    area: face.area, position: face.centroid, axis: face.axis, radius: face.radius });
  const edgeQuery = (edge: SolidEdgeInfo): SubShapeQuery => ({ kind: 'edge', index: edge.index, curveKind: edge.curveKind,
    length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius });
  const near = (a: number, b: number, tolerance = 1e-9): boolean => Math.abs(a - b) <= tolerance;
  /** 上の面(z = 板厚、法線 +z)。 */
  const topFace = (faces: readonly SolidFaceInfo[], z: number): SolidFaceInfo => {
    const found = faces.find(f => f.surfaceKind === 'plane' && f.axis !== null && near(f.axis[2], 1) && near(f.centroid[2], z, 1e-7));
    if (found === undefined) throw new Error('上の面が無い');
    return found;
  };
  /** 両端が与えた 2 点の直線の辺(向きは問わない)。 */
  const edgeBetween = (edges: readonly SolidEdgeInfo[], a: Vec3Tuple, b: Vec3Tuple): SolidEdgeInfo => {
    const same = (p: Vec3Tuple, q: Vec3Tuple) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= 1e-7;
    const found = edges.find(e => e.curveKind === 'line' && ((same(e.start, a) && same(e.end, b)) || (same(e.start, b) && same(e.end, a))));
    if (found === undefined) throw new Error('辺が無い');
    return found;
  };
  function plate(width: number, depth: number): { readonly shape: TopoDS_Shape; readonly release: () => void } {
    const owned = createAllocations();
    const shape = owned.keep(owned.keep(new oc.BRepPrimAPI_MakeBox_2(width, depth, 10)).Shape());
    return { shape, release: owned.release };
  }
  function holeSpec(face: SolidFaceInfo, edge1: SolidEdgeInfo, edge2: SolidEdgeInfo,
    locations: readonly { readonly distance1: number; readonly distance2: number }[]): HoleStepSpec {
    return { kind: 'hole', targetKey: 'plate', face: faceQuery(face), centers: [], diameter: 6, depth: null,
      tiltAngle: 0, tiltAzimuth: 0, transforms: [],
      planar: { kind: 'edge-distance', edge1: edgeQuery(edge1), edge2: edgeQuery(edge2), locations } };
  }

  it('60×40 の板の右の辺と奥の辺から 8・8 の中心は (52, 32)、80×50 では (72, 42)。20・12 は (幅−20, 奥行−12)', () => {
    for (const [width, depth] of [[60, 40], [80, 50]] as const) {
      const { shape, release } = plate(width, depth);
      try {
        const { faces, edges } = tables(shape);
        const top = topFace(faces, 10);
        const right = edgeBetween(edges, [width, 0, 10], [width, depth, 10]);
        const back = edgeBetween(edges, [0, depth, 10], [width, depth, 10]);
        const spec = holeSpec(top, right, back, [{ distance1: 8, distance2: 8 }, { distance1: 20, distance2: 12 }]);
        const frame = resolveHoleFrame(oc, shape, faces, spec, undefined, edges);
        const expected: readonly Vec3Tuple[] = [[width - 8, depth - 8, 10], [width - 20, depth - 12, 10]];
        expect(frame.origins).toHaveLength(2);
        frame.origins.forEach((point, index) => {
          expect(Math.hypot(point[0] - expected[index][0], point[1] - expected[index][1], point[2] - expected[index][2])).toBeLessThanOrEqual(1e-7);
        });
      } finally {
        release();
      }
    }
  });

  it('面の中の穴の縁の辺では、材料のある側(穴の外)へずらす(4×4 の角穴の右と奥の縁から 8・8 は (40, 30))', () => {
    const owned = createAllocations();
    const base = plate(60, 40), body = base.shape;
    try {
      const tool = owned.keep(owned.keep(new oc.BRepPrimAPI_MakeBox_2(4, 4, 12)).Shape());
      const moved = owned.keep(transformShape(oc, tool, { translation: [28, 18, -1], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 }));
      const cut = owned.keep(new oc.BRepAlgoAPI_Cut_3(body, moved.shape, owned.keep(new oc.Message_ProgressRange_1())));
      const shape = owned.keep(cut.Shape());
      const { faces, edges } = tables(shape);
      const top = topFace(faces, 10);
      const innerRight = edgeBetween(edges, [32, 18, 10], [32, 22, 10]);
      const innerBack = edgeBetween(edges, [28, 22, 10], [32, 22, 10]);
      const frame = resolveHoleFrame(oc, shape, faces, holeSpec(top, innerRight, innerBack, [{ distance1: 8, distance2: 8 }]), undefined, edges);
      const [center] = frame.origins;
      expect(Math.hypot(center[0] - 40, center[1] - 30, center[2] - 10)).toBeLessThanOrEqual(1e-7);
    } finally {
      owned.release(); base.release();
    }
  });

  it('平行な辺・同じ辺・円の辺・面の縁でない辺・面の外の中心・有限でない距離は、理由をつけて断る', () => {
    const owned = createAllocations();
    const base = plate(60, 40), body = base.shape;
    try {
      const axes = owned.keep(new oc.gp_Ax2_3(owned.keep(new oc.gp_Pnt_3(30, 20, -1)), owned.keep(new oc.gp_Dir_4(0, 0, 1))));
      const cylinder = owned.keep(owned.keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 12)).Shape());
      const cut = owned.keep(new oc.BRepAlgoAPI_Cut_3(body, cylinder, owned.keep(new oc.Message_ProgressRange_1())));
      const shape = owned.keep(cut.Shape());
      const { faces, edges } = tables(shape);
      const top = topFace(faces, 10);
      const right = edgeBetween(edges, [60, 0, 10], [60, 40, 10]);
      const left = edgeBetween(edges, [0, 0, 10], [0, 40, 10]);
      const back = edgeBetween(edges, [0, 40, 10], [60, 40, 10]);
      const bottomRight = edgeBetween(edges, [60, 0, 0], [60, 40, 0]);
      const circle = edges.find(e => e.curveKind === 'circle' && e.axisOrigin != null && near(e.axisOrigin[2], 10, 1e-7));
      if (circle === undefined) throw new Error('上の面の円の辺が無い');
      const frame = (edge1: SolidEdgeInfo, edge2: SolidEdgeInfo, locations = [{ distance1: 8, distance2: 8 }]) =>
        () => resolveHoleFrame(oc, shape, faces, holeSpec(top, edge1, edge2, locations), undefined, edges);
      expect(frame(right, left)).toThrow('parallel');
      expect(frame(right, right)).toThrow('parallel');
      expect(frame(right, circle)).toThrow('notLine');
      expect(frame(right, bottomRight)).toThrow(/^(?:notOnFace|degenerate|side)$/u);
      expect(frame(right, back, [{ distance1: 70, distance2: 8 }])).toThrow('outside');
      expect(frame(right, back, [{ distance1: Number.NaN, distance2: 8 }])).toThrow('distance');
      expect(frame(right, back, [])).toThrow('distance');
      // 円の穴の中心(30, 20)は面の外(穴の中)。
      expect(frame(right, back, [{ distance1: 30, distance2: 20 }])).toThrow('outside');
      // 中心点・円筒配置と同時には指定できない。
      const spec = holeSpec(top, right, back, [{ distance1: 8, distance2: 8 }]);
      expect(() => resolveHoleFrame(oc, shape, faces, { ...spec, centers: [[52, 32, 10]] }, undefined, edges))
        .toThrow('combination');
      // 辺の一覧を渡さない(別の形の一覧)と、辺は選び直せない。
      expect(() => resolveHoleFrame(oc, shape, faces, spec)).toThrow('辺からの距離の辺が見つかりません。形が大きく変わったため、選び直してください。');
      // makeHole は辺の一覧を受け取らない。中心点の穴に直さずに渡すと、同じ理由で断る(直すのは再計算の段)。
      expect(() => makeHole(oc, spec, shape, faces)).toThrow('辺からの距離の辺が見つかりません。形が大きく変わったため、選び直してください。');
    } finally {
      owned.release(); base.release();
    }
  });

  it('純関数: 側は面の中の答えで決まり、交点は 2 本のずらした線の上にある(斜めの辺)', () => {
    // 三角形の面 (0,0)-(40,0)-(0,30) の斜辺と底辺。斜辺から 5・底辺から 4。
    const inside = (p: Vec3Tuple): boolean => p[0] > 0 && p[1] > 0 && p[0] / 40 + p[1] / 30 < 1;
    const result = edgeDistanceCenters({ origin: [0, 0, 0], normal: [0, 0, 1] },
      [{ start: [40, 0, 0], end: [0, 30, 0] }, { start: [0, 0, 0], end: [40, 0, 0] }], [{ distance1: 5, distance2: 4 }], inside,
      { tolerance: 1e-9, probe: 1e-4 });
    if (!result.ok) throw new Error(result.reason);
    const [center] = result.centers;
    expect(near(center[1], 4)).toBe(true);
    // 斜辺 3x + 4y = 120 からの距離 = (120 − 3x − 4y) / 5 = 5。
    expect(near((120 - 3 * center[0] - 4 * center[1]) / 5, 5)).toBe(true);
    expect(edgeDistanceCenters({ origin: [0, 0, 0], normal: [0, 0, 1] },
      [{ start: [0, 0, 0], end: [40, 0, 0] }, { start: [0, 10, 0], end: [40, 10, 0] }], [{ distance1: 1, distance2: 1 }], () => true,
      { tolerance: 1e-9, probe: 1e-4 })).toEqual({ ok: false, reason: 'side' });
    expect(edgeDistanceCenters({ origin: [0, 0, 0], normal: [0, 0, 1] },
      [{ start: [0, 0, 0], end: [40, 0, 0] }, { start: [0, 0, 1], end: [0, 30, 1] }], [{ distance1: 1, distance2: 1 }], inside,
      { tolerance: 1e-9, probe: 1e-4 })).toEqual({ ok: false, reason: 'degenerate' });
  });
});
