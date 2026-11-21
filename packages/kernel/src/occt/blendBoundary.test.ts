import type { BRepAdaptor_Surface, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurveSpec, SolidEdgeInfo, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import * as boundaryModule from './blendBoundary.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { faceTables } from './loftSurface.testSupport.js';
import { makeBlendSurface } from './makeBlendSurface.js';
import { makeBox } from './makeBox.js';
import { makeSurface } from './makeSurface.js';
import { expectPointClose } from './pointAssertions.testSupport.js';
import { isValidShape } from './solidMesh.js';
import { collectSubShapes, edgeAt, faceAt, type SubShapeTables } from './subShapes.js';
import { APPROXIMATION_TOLERANCE_MM } from './tolerances.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

function locatedEdge(shape: TopoDS_Shape, tables: SubShapeTables, matches: (edge: SolidEdgeInfo) => boolean) {
  const candidates = tables.edges.filter(matches);
  expect(candidates).toHaveLength(1);
  const [edge] = candidates;
  const query = { kind: 'edge' as const, index: edge.index, curveKind: edge.curveKind, length: edge.length,
    position: edge.midpoint, axis: edge.axis, radius: edge.radius };
  return { shape, tables, query, edge };
}

function lineAt(y: number, z: number) {
  return (edge: SolidEdgeInfo) => edge.curveKind === 'line' && edge.axis !== null
    && Math.abs(edge.axis[0]) > 0.99 && Math.abs(edge.midpoint[1] - y) < APPROXIMATION_TOLERANCE_MM
    && Math.abs(edge.midpoint[2] - z) < APPROXIMATION_TOLERANCE_MM;
}

function plate(owner: Allocations, y: number, z: number, interior: readonly [number, number], reverse = false) {
  const x0 = reverse ? 10 : 0, x1 = reverse ? 0 : 10;
  const corners: readonly Vec3Tuple[] = [[x0, y, z], [x1, y, z],
    [x1, y + interior[0], z + interior[1]], [x0, y + interior[0], z + interior[1]]];
  const profile = corners.map((from, i): CurveSpec => ({ kind: 'segment', from, to: corners[(i + 1) % corners.length] }));
  const { shape } = owner.keep(makeSurface(oc, { kind: 'planar', profile }));
  const tables = faceTables(oc, shape);
  expect(tables.faces.map(face => face.surfaceKind)).toEqual(['plane']);
  return locatedEdge(shape, tables, lineAt(y, z));
}

function sample(surface: BRepAdaptor_Surface, u: number, v: number, owner: Allocations) {
  const p = owner.keep(new oc.gp_Pnt_1());
  const du = owner.keep(new oc.gp_Vec_1()), dv = owner.keep(new oc.gp_Vec_1());
  surface.D1(u, v, p, du, dv);
  return { point: [p.X(), p.Y(), p.Z()] as const, dv: [dv.X(), dv.Y(), dv.Z()] as const };
}

type SelectedEdge = ReturnType<typeof locatedEdge>;
function builtFace(owner: Allocations, a: SelectedEdge, b: SelectedEdge, flipB: boolean, weights: readonly [number, number]) {
  const result = makeBlendSurface(oc, { a, b, weightA: weights[0], weightB: weights[1], flipB });
  if (result.status !== 'shape') throw new Error(`${result.status}: ${result.exceeded.join(', ')}`);
  owner.keep(result);
  expect(result.shape.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_FACE);
  expect(isValidShape(oc, result.shape)).toBe(true);
  expect(result.measurement.maxAngleDeg).toBeLessThan(0.01);
  expect(result.measurement.maxDistanceMm).toBeLessThan(APPROXIMATION_TOLERANCE_MM);
  return owner.keep(new oc.BRepAdaptor_Surface_2(result.shape, true));
}

function cylindricalRim(owner: Allocations, baseZ: number, rimZ: number) {
  const arc: CurveSpec = { kind: 'arc', center: [0, 0, baseZ], normal: [0, 0, 1], xAxis: [1, 0, 0],
    radius: 4, startAngle: 0, endAngle: Math.PI / 2 };
  const { shape } = owner.keep(makeSurface(oc, { kind: 'extrude', profile: [arc], direction: [0, 0, 1], distance: 2 }));
  const tables = faceTables(oc, shape);
  expect(tables.faces.map(face => face.surfaceKind)).toEqual(['cylinder']);
  return locatedEdge(shape, tables, edge => edge.curveKind === 'circle'
    && Math.abs(edge.midpoint[2] - rimZ) < APPROXIMATION_TOLERANCE_MM);
}

describe('実形状の境界辺から作るつなぎ面', () => {
  it('同じ位置の節が両側から異なる丸めで届いても端点を保って面を作る', () => {
    const owner = createAllocations();
    const read = boundaryModule.readBlendBoundary;
    const measured = new Set<number>();
    const probe = vi.spyOn(boundaryModule, 'readBlendBoundary').mockImplementation((instance, source, side, allocations) => {
      const boundary = read(instance, source, side, allocations);
      const middle = side === 'a' ? 0.5 : 0.5 + Number.EPSILON;
      return { ...boundary, knots: [...boundary.knots, Number.EPSILON, middle, 1 - Number.EPSILON],
        evaluate: (u: number) => { if (side === 'a') measured.add(u); return boundary.evaluate(u); } };
    });
    try {
      const a = plate(owner, 0, 0, [-2, 0]), b = plate(owner, 3, 3, [0, 2]);
      const face = builtFace(owner, a, b, a.edge.start[0] !== b.edge.start[0], [3, 6]);
      expect(measured.has(Number.EPSILON)).toBe(true);
      expect(measured.has(1 - Number.EPSILON)).toBe(true);
      for (const u of [0, 0.5, 1]) {
        const x = (1 - u) * a.edge.start[0] + u * a.edge.end[0];
        expectPointClose(sample(face, u, 0, owner).point, [x, 0, 0], 10);
        expectPointClose(sample(face, u, 1, owner).point, [x, 3, 3], 10);
      }
    } finally { probe.mockRestore(); owner.release(); }
  });

  it.each([false, true])('円弧の 2 回目の当て直しを取り消す (非同期 %s)', async asynchronous => {
    const owner = createAllocations();
    try {
      const a = cylindricalRim(owner, -2, 0), b = cylindricalRim(owner, 3, 3);
      const flipB = Math.abs(a.edge.start[0] - b.edge.start[0]) > APPROXIMATION_TOLERANCE_MM;
      let checks = 0;
      const result = await makeBlendSurface(oc, { a, b, weightA: 3, weightB: 3, flipB },
        { distanceMm: 0, angleDeg: 0.01 }, () => {
          const cancel = ++checks === 2;
          return asynchronous ? Promise.resolve(cancel) : cancel;
        });
      if (result.status === 'shape') owner.keep(result);
      expect(result).toEqual({ status: 'cancelled' });
      expect(checks).toBe(2);
    } finally { owner.release(); }
  });

  it('直交する 2 面で A を出る接線と B に入る接線を D1 から測る', () => {
    const owner = createAllocations();
    try {
      const a = plate(owner, 0, 0, [-2, 0]), b = plate(owner, 3, 3, [0, 2]);
      const face = builtFace(owner, a, b, a.edge.start[0] !== b.edge.start[0], [3, 6]);
      const u = 0.25, x = (1 - u) * a.edge.start[0] + u * a.edge.end[0];
      const start = sample(face, u, 0, owner), end = sample(face, u, 1, owner);
      expectPointClose(start.point, [x, 0, 0], 10); expectPointClose(start.dv, [0, 3, 0], 10);
      expectPointClose(end.point, [x, 3, 3], 10); expectPointClose(end.dv, [0, 0, 6], 10);
      expectPointClose(sample(face, u, 0.5, owner).point, [x, 15 / 8, 6 / 8], 10);
    } finally { owner.release(); }
  });

  it('平行で高さの異なる 2 面を S 字で結び、面全体を裏返しても内外を保つ', () => {
    const owner = createAllocations();
    try {
      const a = plate(owner, 0, 0, [-2, 0]), original = plate(owner, 6, 4, [2, 0]);
      const shape = owner.keep(original.shape.Reversed());
      const b = locatedEdge(shape, faceTables(oc, shape), lineAt(6, 4));
      const face = builtFace(owner, a, b, a.edge.start[0] !== b.edge.start[0], [6, 6]);
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const value = sample(face, 0.5, v, owner);
        expectPointClose(value.point, [5, 6 * v, 4 * v * v * (3 - 2 * v)], 10);
        expectPointClose(value.dv, [0, 6, 24 * v * (1 - v)], 10);
      }
    } finally { owner.release(); }
  });

  it('逆向きに作った B の実際の両端を flipB で対応させ、横接線の符号を保つ', () => {
    const owner = createAllocations();
    try {
      const a = plate(owner, 0, 0, [-2, 0]), b = plate(owner, 3, 3, [0, 2], true);
      expect(a.edge.start[0]).toBeCloseTo(b.edge.end[0], 10);
      expect(a.edge.end[0]).toBeCloseTo(b.edge.start[0], 10);
      const face = builtFace(owner, a, b, true, [3, 6]);
      for (const u of [0, 0.25, 0.75, 1]) {
        const x = (1 - u) * a.edge.start[0] + u * a.edge.end[0];
        const value = sample(face, u, 1, owner);
        expectPointClose(value.point, [x, 3, 3], 10);
        expectPointClose(value.dv, [0, 0, 6], 10);
      }
    } finally { owner.release(); }
  });

  it('支持面のない単独の辺と、箱の 2 面で共有する辺を理由つきで断る', () => {
    const owner = createAllocations();
    try {
      const b = plate(owner, 3, 3, [0, 2]);
      const { shape } = owner.keep(makeBox(oc, { dx: 10, dy: 2, dz: 2 }));
      const shared = locatedEdge(shape, faceTables(oc, shape), lineAt(0, 0));
      const edge = edgeAt(oc, shape, shared.edge.index);
      if (edge === null) throw new Error('箱の辺を取得できません。');
      owner.keep(edge);
      const tables = collectSubShapes(oc, edge, [], extractEdges(oc, edge).edgeRanges);
      const free = locatedEdge(edge, tables, lineAt(0, 0));
      for (const a of [free, shared]) {
        expect(() => makeBlendSurface(oc, { a, b, weightA: 3, weightB: 6, flipB: false }))
          .toThrow('boundary-required');
      }
    } finally { owner.release(); }
  });

  it('円筒の境界で変化する接平面に合わせ、標本の離れをゼロに指定した時は断る', () => {
    const owner = createAllocations();
    try {
      const a = cylindricalRim(owner, -2, 0), b = cylindricalRim(owner, 3, 3);
      const flipB = Math.abs(a.edge.start[0] - b.edge.start[0]) > APPROXIMATION_TOLERANCE_MM;
      const face = builtFace(owner, a, b, flipB, [3, 3]);
      for (const v of [0, 0.5, 1]) {
        const value = sample(face, 0.5, v, owner);
        expectPointClose(value.point, [Math.sqrt(8), Math.sqrt(8), 3 * v], 6);
        expectPointClose(value.dv, [0, 0, 3], 9);
      }
      const result = makeBlendSurface(oc, { a, b, weightA: 3, weightB: 3, flipB }, { distanceMm: 0, angleDeg: 0.01 });
      if (result.status === 'shape') owner.keep(result);
      expect(result.status).toBe('outside-tolerance');
      if (result.status === 'outside-tolerance') {
        expect(result.exceeded).toEqual(['distance']);
        expect(result.measurement.maxDistanceMm).toBeGreaterThan(0);
      }
    } finally { owner.release(); }
  });

  it('円筒側面だけを取り出しても、同じ面の両側に現れる継ぎ目は境界に使わない', () => {
    const owner = createAllocations();
    try {
      const cylinder = owner.keep(new oc.BRepPrimAPI_MakeCylinder_1(4, 2));
      const shape = owner.keep(cylinder.Shape());
      const sides = faceTables(oc, shape).faces.filter(face => face.surfaceKind === 'cylinder'
        && face.radius === 4 && face.axis !== null && Math.abs(face.axis[2]) > 0.99);
      expect(sides).toHaveLength(1);
      const face = faceAt(oc, shape, sides[0].index);
      if (face === null) throw new Error('円筒の側面を取得できません。');
      owner.keep(face);
      const a = locatedEdge(face, faceTables(oc, face), edge => edge.curveKind === 'line' && edge.axis !== null
        && Math.abs(edge.axis[2]) > 0.99 && Math.abs(edge.midpoint[2] - 1) < APPROXIMATION_TOLERANCE_MM);
      const b = plate(owner, 3, 3, [0, 2]);
      expect(() => makeBlendSurface(oc, { a, b, weightA: 3, weightB: 6, flipB: false }))
        .toThrow('boundary-required');
    } finally { owner.release(); }
  });
});
