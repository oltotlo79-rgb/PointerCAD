import { beforeAll, describe, expect, it } from 'vitest';
import type { HoleStepSpec, SolidFaceInfo, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { writeBrepBytes } from './brepBytes.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeHole, resolveHoleFrame } from './makeHole.js';
import { readNativePlanarBasis } from './planarFaceBasis.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { extractEdges } from './extractEdges.js';
import { holeOracleTimes, holeOraclePlus, type HoleOracleMatrix } from './holePlacementOracle.testSupport.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;
const O: Vec3Tuple = [11, -7, 5], U: Vec3Tuple = [3/5, 4/5, 0], N: Vec3Tuple = [-12/25, 9/25, 4/5];
const ID: HoleOracleMatrix = [[1,0,0], [0,1,0], [0,0,1]];
const RZ: HoleOracleMatrix = [[0,-1,0], [1,0,0], [0,0,1]];
const POSES = [
  { name: 'oblique native plane', rotation: ID, translation: [0,0,0] as Vec3Tuple },
  { name: 'oblique plane then Rz90 and translation', rotation: RZ, translation: [31,-19,7] as Vec3Tuple },
];
function near(a: Vec3Tuple, b: Vec3Tuple, tolerance: number) {
  expect(Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2])).toBeLessThanOrEqual(tolerance);
}
describe('native planar XY independent oracle candidate', () => {
  let oc: Occt;
  beforeAll(async () => { oc = await loadOcctForNode(); });
  function fixture(pose = POSES[0]) {
    const owned = createAllocations(), keep = owned.keep;
    try {
      const point = (v: Vec3Tuple) => holeOraclePlus(holeOracleTimes(pose.rotation, v), pose.translation);
      const vector = (v: Vec3Tuple) => holeOracleTimes(pose.rotation, v);
      const o = point(O), u = vector(U), n = vector(N);
      const ax = keep(new oc.gp_Ax3_3(keep(new oc.gp_Pnt_3(...o)), keep(new oc.gp_Dir_4(...n)), keep(new oc.gp_Dir_4(...u))));
      const plane = keep(new oc.gp_Pln_2(ax));
      const faceMaker = keep(new oc.BRepBuilderAPI_MakeFace_9(plane, -20, 20, -15, 15));
      const face = keep(faceMaker.Face());
      const prism = keep(new oc.BRepPrimAPI_MakePrism_1(face, keep(new oc.gp_Vec_4(-10*n[0], -10*n[1], -10*n[2])), true, false));
      const shape = keep(prism.Shape());
      const mesh = tessellate(oc, shape), edges = extractEdges(oc, shape);
      const faces = collectSubShapes(oc, shape, mesh.faceRanges, edges.edgeRanges).faces;
      const top = faces.find(f => f.surfaceKind === 'plane' && f.axis !== null &&
        Math.hypot(f.axis[0]-n[0], f.axis[1]-n[1], f.axis[2]-n[2]) < 1e-9);
      if (top === undefined) throw new Error('Missing input top plane');
      const query = (f: SolidFaceInfo) => ({ kind: 'face' as const, index: f.index, surfaceKind: f.surfaceKind,
        area: f.area, position: f.centroid, axis: f.axis, radius: f.radius });
      const spec: HoleStepSpec = { kind: 'hole', targetKey: 'fixture', face: query(top), centers: [], diameter: 6,
        depth: null, tiltAngle: 0, tiltAzimuth: 0, transforms: [],
        planar: { kind: 'plane-face', locations: [{ x: 6, y: -4 }, { x: -3, y: 5 }] } };
      return { shape, faces, top, spec, point, vector, query, nativeFace: face, delete: owned.release };
    } catch (error) { owned.release(); throw error; }
  }
  it.each(POSES)('$name: signed XY, inward direction, diameter and analytic volume', pose => {
    const f = fixture(pose);
    try {
      const before = writeBrepBytes(oc, f.shape);
      // V=N×U=(-16/25,12/25,-3/5)。期待値は製品の基準を読む前に入力だけから導く。
      const expected = [f.point([17.16,-4.12,7.4]), f.point([6,-7,2])];
      const frame = resolveHoleFrame(oc, f.shape, f.faces, f.spec);
      expect(frame.origins).toHaveLength(2);
      frame.origins.forEach((p, i) => near(p, expected[i], 1e-7));
      near(frame.direction, f.vector([12/25,-9/25,-4/5]), 1e-9);
      if (f.top.planarBasis === undefined) throw new Error('Missing UI frame');
      near(f.top.planarBasis.origin, f.point(O), 1e-7);
      near(f.top.planarBasis.xAxis, f.vector(U), 1e-9);
      near(f.top.planarBasis.yAxis, f.vector([-16/25,12/25,-3/5]), 1e-9);
      const result = makeHole(oc, f.spec, f.shape, f.faces);
      try {
        expect(Math.abs(result.volume - (12000 - 180*Math.PI))/(12000 - 180*Math.PI)).toBeLessThan(1e-9);
        const mesh = tessellate(oc, result.shape), edges = extractEdges(oc, result.shape);
        const bores = collectSubShapes(oc, result.shape, mesh.faceRanges, edges.edgeRanges).faces.filter(face => face.surfaceKind === 'cylinder');
        expect(bores).toHaveLength(2);
        for (const bore of bores) {
          if (bore.radius === null || bore.axis === null || bore.axisOrigin == null) throw new Error('Missing bore geometry');
          expect(Math.abs(2*bore.radius - 6)).toBeLessThanOrEqual(1e-7);
          const axis = bore.axis, origin = bore.axisOrigin;
          const distance = (p: Vec3Tuple) => {
            const d = [p[0]-origin[0], p[1]-origin[1], p[2]-origin[2]];
            return Math.hypot(d[1]*axis[2]-d[2]*axis[1], d[2]*axis[0]-d[0]*axis[2], d[0]*axis[1]-d[1]*axis[0]);
          };
          expect(Math.min(...expected.map(distance))).toBeLessThanOrEqual(1e-7);
        }
      } finally { result.delete(); }
      expect(writeBrepBytes(oc, f.shape)).toEqual(before);
    } finally { f.delete(); }
  });
  it('rejects edge/outside/empty/nonfinite/conflicting placements without changing the borrowed shape', () => {
    const f = fixture();
    try {
      const before = writeBrepBytes(oc, f.shape);
      const cases: HoleStepSpec[] = [
        ...[[20,0], [21,0], [NaN,0], [0,Infinity]].map(([x,y]) => ({ ...f.spec,
          planar: { kind: 'plane-face' as const, locations: [{ x, y }] } })),
        { ...f.spec, planar: { kind: 'plane-face', locations: [] } },
        { ...f.spec, centers: [[0,0,0]] },
        { ...f.spec, cylindrical: { kind: 'cylinder-face', locations: [{ height: 1, angle: 0 }] } },
      ];
      for (const spec of cases) expect(() => resolveHoleFrame(oc, f.shape, f.faces, spec)).toThrow();
      expect(writeBrepBytes(oc, f.shape)).toEqual(before);
      const legacy = resolveHoleFrame(oc, f.shape, f.faces, { face: f.spec.face,
        tiltAngle: 0, tiltAzimuth: 0, centers: [[17.16,-4.12,7.4]] });
      near(legacy.origins[0], [17.16,-4.12,7.4], 1e-7);
    } finally { f.delete(); }
  });
  it('裏面は外向き法線と面内Yが反転し、内向きに穴をあける', () => {
    const f = fixture();
    try {
      const bottom = f.faces.find(face => face.surfaceKind === 'plane' && face.axis !== null
        && Math.hypot(face.axis[0]+N[0], face.axis[1]+N[1], face.axis[2]+N[2]) < 1e-9);
      if (bottom === undefined) throw new Error('裏面がありません');
      const spec: HoleStepSpec = { ...f.spec, face: f.query(bottom),
        planar: { kind: 'plane-face', locations: [{ x: 6, y: -4 }] } };
      const frame = resolveHoleFrame(oc, f.shape, f.faces, spec);
      // O-10N+6U+4V。表の期待値や製品のbasisから計算しない。
      near(frame.origins[0], [16.84,-3.88,-5.4], 1e-7);
      near(frame.direction, [-12/25,9/25,4/5], 1e-9);
      const result = makeHole(oc, spec, f.shape, f.faces);
      try {
        const expected = 12000 - 90*Math.PI;
        expect(Math.abs(result.volume-expected)/expected).toBeLessThan(1e-9);
      } finally { result.delete(); }
    } finally { f.delete(); }
  });
  it('内周の空洞内と輪郭上を実面の分類で拒否する', () => {
    const f = fixture();
    try {
      const cut = makeHole(oc, f.spec, f.shape, f.faces);
      try {
        const mesh = tessellate(oc, cut.shape), edges = extractEdges(oc, cut.shape);
        const faces = collectSubShapes(oc, cut.shape, mesh.faceRanges, edges.edgeRanges).faces;
        const top = faces.find(face => face.surfaceKind === 'plane' && face.axis !== null
          && Math.hypot(face.axis[0]-N[0], face.axis[1]-N[1], face.axis[2]-N[2]) < 1e-9);
        if (top === undefined) throw new Error('穴をあけた平面がありません');
        for (const x of [6, 9]) {
          const spec: HoleStepSpec = { ...f.spec, face: f.query(top),
            planar: { kind: 'plane-face', locations: [{ x, y: -4 }] } };
          expect(() => resolveHoleFrame(oc, cut.shape, faces, spec)).toThrow('選択面の内側');
        }
      } finally { cut.delete(); }
    } finally { f.delete(); }
  });
  it('INTERNALとEXTERNALの面に外向きの基準を捏造しない', () => {
    const f = fixture(), owned = createAllocations();
    try {
      // bindingの列挙定数は{}型。native getterが返す実際の型を使う。
      const emptyFace = owned.keep(new oc.TopoDS_Face());
      const complemented = owned.keep(emptyFace.Complemented());
      expect(emptyFace.Orientation_1()).toBe(oc.TopAbs_Orientation.TopAbs_EXTERNAL);
      expect(complemented.Orientation_1()).toBe(oc.TopAbs_Orientation.TopAbs_INTERNAL);
      for (const orientation of [emptyFace.Orientation_1(), complemented.Orientation_1()]) {
        const oriented = owned.keep(f.nativeFace.Oriented(orientation));
        const face = owned.keep(oc.TopoDS.Face_1(oriented));
        expect(readNativePlanarBasis(oc, face, owned.keep)).toBeNull();
      }
    } finally { owned.release(); f.delete(); }
  });
});
