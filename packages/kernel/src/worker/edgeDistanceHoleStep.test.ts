import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { HoleStepSpec, SolidEdgeInfo, SolidFaceInfo, SolidStepRequest, SolidStepSpec, SubShapeQuery, ThreadStepSpec,
  Vec3Tuple } from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/**
 * 辺からの距離の穴・ねじ穴(M-02)を再計算の段で作る。`makeHole`・`makeThreadHole` は辺の一覧を受け取らないので、
 * 段が今の形の辺の一覧で中心を求めて渡す(`recomputeSolids.ts` の `withEdgeDistanceCenters`)。
 * 期待の体積は、製品の式を使わずに板と穴の寸法から手で出す。
 */
describe('辺からの距離の穴の再計算の段(M-02)', () => {
  let oc: Occt;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  const plateStep: SolidStepRequest = { id: 'plate', key: 'plate-key', label: 'plate', visible: true, step: {
    kind: 'extrude', direction: [0, 0, 1], distance: 10, profile: [
      { kind: 'segment', from: [0, 0, 0], to: [60, 0, 0] }, { kind: 'segment', from: [60, 0, 0], to: [60, 40, 0] },
      { kind: 'segment', from: [60, 40, 0], to: [0, 40, 0] }, { kind: 'segment', from: [0, 40, 0], to: [0, 0, 0] },
    ] } };
  const near = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) <= tolerance;
  const topFace = (faces: readonly SolidFaceInfo[]): SolidFaceInfo => {
    const found = faces.find(f => f.surfaceKind === 'plane' && f.axis !== null && near(f.axis[2], 1, 1e-9) && near(f.centroid[2], 10, 1e-7));
    if (found === undefined) throw new Error('上の面が無い');
    return found;
  };
  const edgeBetween = (edges: readonly SolidEdgeInfo[], a: Vec3Tuple, b: Vec3Tuple): SolidEdgeInfo => {
    const same = (p: Vec3Tuple, q: Vec3Tuple) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= 1e-7;
    const found = edges.find(e => e.curveKind === 'line' && ((same(e.start, a) && same(e.end, b)) || (same(e.start, b) && same(e.end, a))));
    if (found === undefined) throw new Error('辺が無い');
    return found;
  };
  const faceQuery = (face: SolidFaceInfo): SubShapeQuery => ({ kind: 'face', index: face.index, surfaceKind: face.surfaceKind,
    area: face.area, position: face.centroid, axis: face.axis, radius: face.radius });
  const edgeQuery = (edge: SolidEdgeInfo): SubShapeQuery => ({ kind: 'edge', index: edge.index, curveKind: edge.curveKind,
    length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius });

  it('押し出しの板の右と奥の辺から、穴(8・8 と 20・12)とねじ穴(8・8)をあけ、平行な辺は理由をつけて断る', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const initial = await recomputeSolids({ oc, cache }, { steps: [plateStep], generation: 1 });
      expect(initial.failures).toEqual([]);
      const [plate] = initial.bodies;
      const face = faceQuery(topFace(plate.faces));
      const right = edgeQuery(edgeBetween(plate.edges, [60, 0, 10], [60, 40, 10]));
      const back = edgeQuery(edgeBetween(plate.edges, [0, 40, 10], [60, 40, 10]));
      const left = edgeQuery(edgeBetween(plate.edges, [0, 0, 10], [0, 40, 10]));
      const run = (step: SolidStepSpec) => recomputeSolids({ oc, cache },
        { steps: [{ ...plateStep, visible: false }, { id: 'hole', key: `hole-${JSON.stringify(step)}`, label: 'hole', visible: true, step }],
          generation: 1 });
      const hole: HoleStepSpec = { kind: 'hole', targetKey: plateStep.key, face, centers: [], diameter: 6, depth: null,
        tiltAngle: 0, tiltAzimuth: 0, transforms: [],
        planar: { kind: 'edge-distance', edge1: right, edge2: back, locations: [{ distance1: 8, distance2: 8 }, { distance1: 20, distance2: 12 }] } };
      const solid = 60 * 40 * 10;
      const drilled = await run(hole);
      expect(drilled.failures).toEqual([]);
      expect(drilled.bodies[0]?.volume).toBeCloseTo(solid - 2 * Math.PI * 3 * 3 * 10, 6);
      const thread: ThreadStepSpec = { kind: 'thread', targetKey: plateStep.key, face, centers: [], drillDiameter: 5, depth: null,
        tiltAngle: 0, tiltAzimuth: 0, transforms: [], thread: null, mark: null,
        planar: { kind: 'edge-distance', edge1: right, edge2: back, locations: [{ distance1: 8, distance2: 8 }] } };
      const tapped = await run(thread);
      expect(tapped.failures).toEqual([]);
      expect(tapped.bodies[0]?.volume).toBeCloseTo(solid - Math.PI * 2.5 * 2.5 * 10, 6);
      const parallel = await run({ ...hole, planar: { kind: 'edge-distance', edge1: right, edge2: left, locations: [{ distance1: 8, distance2: 8 }] } });
      expect(parallel.failures).toMatchObject([{ id: 'hole', message: '辺からの距離には平行でない2本の辺を選んでください。' }]);
    } finally {
      cache.clear();
    }
  });
});
