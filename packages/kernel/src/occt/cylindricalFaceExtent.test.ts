import { beforeAll, describe, expect, it } from 'vitest';

import type { CurrentOriginIndex, OriginBinding } from '../subShapeOrigin.js';
import type { SolidFaceInfo, SubShapeQuery, ThreadStepSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { cylindricalFaceAxialExtent } from './cylindricalFaceSpan.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { makeThreadHole } from './makeThread.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes, faceAt } from './subShapes.js';
import { tessellate } from './tessellate.js';

/*
 * 円筒の面の今の軸方向範囲(cylinderAxialExtent)。全周の帯(cylinderSpan)の証明とは別の情報。
 * 期待は手計算: 円柱の高さ、板の厚さ、Root の診断(run 20261014-035358)で測った実らせんの壁の z 範囲。
 * 範囲は axisOrigin から向きを揃えた axis に沿う距離で、生の V や全体の z の範囲ではない。
 */

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;
const M6_MINOR_DIAMETER = 6 - 1.0825317547305482;

function length(extent: readonly [number, number] | null | undefined): number {
  return extent == null ? Number.NaN : extent[1] - extent[0];
}

/** 範囲の端を世界の点へ戻す(axisOrigin + axis × 距離)。 */
function endPoint(face: SolidFaceInfo, distance: number): Vec3Tuple {
  const origin = face.axisOrigin, axis = face.axis;
  if (origin == null || axis === null) throw new Error('no analytic axis');
  return [origin[0] + axis[0] * distance, origin[1] + axis[1] * distance, origin[2] + axis[2] * distance];
}

describe('円筒の面の今の軸方向範囲(全周の証明とは別)', () => {
  let oc: Occt;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  function tablesOf(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function sideOf(faces: readonly SolidFaceInfo[], radius: number): readonly SolidFaceInfo[] {
    return faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? Number.NaN) - radius) < 1e-9);
  }

  it.each([
    { label: 'Z 向き', axis: [0, 0, 1] as Vec3Tuple },
    { label: '回した X 向き', axis: [1, 0, 0] as Vec3Tuple },
    { label: '斜め', axis: [0, 0.6, 0.8] as Vec3Tuple },
  ])('全周の円柱の側面($label): 範囲は全周の帯と同じで、長さは高さ 7', ({ axis }) => {
    const handle = makePrimitive(oc, { kind: 'primitive', origin: [3, -2, 5], axis,
      shape: { kind: 'cylinder', radius: 2, height: 7 }, originQuery: null, targetKey: null }, 'extent-cylinder');
    try {
      const sides = sideOf(tablesOf(handle.shape).faces, 2);
      expect(sides).toHaveLength(1);
      const side = sides[0];
      if (side === undefined) throw new Error('side missing');
      expect(side.cylinderSpan).not.toBeNull();
      expect(side.cylinderAxialExtent).toEqual(side.cylinderSpan);
      expect(length(side.cylinderAxialExtent)).toBeCloseTo(7, 9);
    } finally { handle.delete(); }
  });

  function threadedPlate(height: number, depth: number | null, thread: ThreadStepSpec['thread']) {
    const target = makePrimitive(oc, { kind: 'primitive', origin: [20, 15, height / 2], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: height }, originQuery: null, targetKey: null }, 'extent-plate');
    // 途中で断られたら、ここで作った板を手放してから同じ例外を投げ直す(成功したときは呼び出し側が手放す)。
    try {
      const faces = tablesOf(target.shape).faces;
      const top = faces.find((face) => face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[2] - 1) < 1e-9);
      if (top === undefined) throw new Error('top face missing');
      const query: Extract<SubShapeQuery, { kind: 'face' }> = { kind: 'face', index: top.index, surfaceKind: top.surfaceKind,
        area: top.area, position: top.centroid, axis: top.axis, radius: top.radius };
      const result = makeThreadHole(oc, { kind: 'thread', targetKey: 'target', face: query, centers: [[20, 15, height]],
        drillDiameter: M6_MINOR_DIAMETER, depth, tiltAngle: 0, tiltAzimuth: 0, transforms: [], thread,
        mark: { majorDiameter: 6, length: thread?.length ?? 8 } }, target.shape, faces, target.origins, 'extent-thread');
      return { target, result };
    } catch (error) {
      target.delete();
      throw error;
    }
  }

  it('内側の穴の壁(向きが逆): 簡略表示の貫通の下穴は、全周の帯と同じ範囲で長さは板の厚さ 10', () => {
    const { target, result } = threadedPlate(10, null, null);
    try {
      const walls = sideOf(tablesOf(result.handle.shape).faces, M6_MINOR_DIAMETER / 2);
      expect(walls).toHaveLength(1);
      const wall = walls[0];
      if (wall === undefined || wall.cylinderAxialExtent == null) throw new Error('wall extent missing');
      expect(wall.cylinderAxialExtent).toEqual(wall.cylinderSpan);
      expect(length(wall.cylinderAxialExtent)).toBeCloseTo(10, 9);
      const ends = [endPoint(wall, wall.cylinderAxialExtent[0])[2], endPoint(wall, wall.cylinderAxialExtent[1])[2]].sort((a, b) => a - b);
      expect(ends[0]).toBeCloseTo(0, 6);
      expect(ends[1]).toBeCloseTo(10, 6);
    } finally { result.handle.delete(); target.delete(); }
  });

  it('部分の面(実らせんで分かれた止まりの壁): 全周の帯は無いが、各面の範囲は有限で、世界の z は 8〜20 の中', () => {
    const { target, result } = threadedPlate(20, 12, { majorDiameter: 6, pitch: 1, length: 8 });
    try {
      const walls = sideOf(tablesOf(result.handle.shape).faces, M6_MINOR_DIAMETER / 2);
      expect(walls.length).toBeGreaterThan(1);
      for (const wall of walls) {
        expect(wall.cylinderSpan).toBeNull();
        const extent = wall.cylinderAxialExtent;
        if (extent == null) throw new Error(`patch ${String(wall.index)} extent missing`);
        expect(extent.every(Number.isFinite)).toBe(true);
        expect(extent[1]).toBeGreaterThan(extent[0]);
        for (const z of [endPoint(wall, extent[0])[2], endPoint(wall, extent[1])[2]]) {
          expect(z).toBeGreaterThanOrEqual(8 - 1e-6);
          expect(z).toBeLessThanOrEqual(20 + 1e-6);
        }
      }
    } finally { result.handle.delete(); target.delete(); }
  });

  it.each([false, true])('倍率 2 の Location を持つ円柱(反転=%s): 範囲は倍率込みの長さ 20 で、端は世界の z 17 と 37', (reversed) => {
    // 半径 5・高さ 10 の円柱に、倍率 2 と平行移動 (11,13,17) の Location を付ける。生の V(0〜10)や
    // 倍率を落とした値なら長さ 10 になり、向きを取り違えれば端が z 17/37 から外れる。
    const owned = createAllocations();
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeCylinder_1(5, 10));
      const base = owned.keep(maker.Shape());
      const shape = reversed ? owned.keep(base.Reversed()) : base;
      const transform = owned.keep(new oc.gp_Trsf_1());
      transform.SetValues(2, 0, 0, 11, 0, 2, 0, 13, 0, 0, 2, 17);
      const scaled = owned.keep(shape.Moved(owned.keep(new oc.TopLoc_Location_2(transform)), false));
      const sides = sideOf(tablesOf(scaled).faces, 10);
      expect(sides).toHaveLength(1);
      const side = sides[0];
      if (side === undefined || side.cylinderAxialExtent == null) throw new Error('scaled extent missing');
      expect(length(side.cylinderAxialExtent)).toBeCloseTo(20, 9);
      const ends = [endPoint(side, side.cylinderAxialExtent[0]), endPoint(side, side.cylinderAxialExtent[1])]
        .sort((first, second) => first[2] - second[2]);
      for (const [index, z] of [[0, 17], [1, 37]] as const) {
        expect(ends[index]?.[0]).toBeCloseTo(11, 9);
        expect(ends[index]?.[1]).toBeCloseTo(13, 9);
        expect(ends[index]?.[2]).toBeCloseTo(z, 9);
      }
      expect(side.cylinderAxialExtent).toEqual(side.cylinderSpan);
    } finally { owned.release(); }
  });

  it('円筒でない面・非有限の軸・軸なしでは範囲を出さない', () => {
    const handle = makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
      shape: { kind: 'cylinder', radius: 2, height: 7 }, originQuery: null, targetKey: null }, 'extent-cylinder');
    const owned = createAllocations();
    try {
      const faces = tablesOf(handle.shape).faces;
      const plane = faces.find((face) => face.surfaceKind === 'plane');
      const side = sideOf(faces, 2)[0];
      if (plane === undefined || side === undefined || side.axisOrigin == null || side.axis === null) throw new Error('fixture');
      expect(plane.cylinderAxialExtent ?? null).toBeNull();
      const planeFace = faceAt(oc, handle.shape, plane.index), sideFace = faceAt(oc, handle.shape, side.index);
      if (planeFace === null || sideFace === null) throw new Error('faces missing');
      owned.keep(planeFace);
      owned.keep(sideFace);
      expect(cylindricalFaceAxialExtent(oc, planeFace, [0, 0, 0], [0, 0, 1], 2, owned)).toBeNull();
      expect(cylindricalFaceAxialExtent(oc, sideFace, [Number.NaN, 0, 0], side.axis, 2, owned)).toBeNull();
      expect(cylindricalFaceAxialExtent(oc, sideFace, side.axisOrigin, null, 2, owned)).toBeNull();
      expect(cylindricalFaceAxialExtent(oc, sideFace, side.axisOrigin, side.axis, Number.POSITIVE_INFINITY, owned)).toBeNull();
      expect(cylindricalFaceAxialExtent(oc, sideFace, side.axisOrigin, side.axis, 2, owned)).toEqual(side.cylinderAxialExtent);
    } finally { owned.release(); handle.delete(); }
  });
});

describe('実らせんの由来の鎖と今の隣の面(native)', () => {
  let oc: Occt;
  beforeAll(async () => { oc = await loadOcctForNode(); });
  const ANCHOR = { sketchId: 'centers', producer: { kind: 'point', featureId: 'p1' } } as const;
  const OTHER = { sketchId: 'centers', producer: { kind: 'point', featureId: 'p2' } } as const;

  function tablesOf(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  /** 名前付き(centerAnchors・placementRoles あり)の実らせん。中心ごとの錨は呼び出し側が決める。 */
  function namedThread(height: number, depth: number | null, centers: readonly Vec3Tuple[], anchors: readonly (typeof ANCHOR | typeof OTHER)[]) {
    const target = makePrimitive(oc, { kind: 'primitive', origin: [20, 15, height / 2], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: height }, originQuery: null, targetKey: null }, 'chain-plate');
    try {
      const faces = tablesOf(target.shape).faces;
      const top = faces.find((face) => face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[2] - 1) < 1e-9);
      if (top === undefined) throw new Error('top face missing');
      const query: Extract<SubShapeQuery, { kind: 'face' }> = { kind: 'face', index: top.index, surfaceKind: top.surfaceKind,
        area: top.area, position: top.centroid, axis: top.axis, radius: top.radius };
      const result = makeThreadHole(oc, { kind: 'thread', targetKey: 'target', face: query, centers: [...centers],
        centerAnchors: [...anchors], placementRoles: [], drillDiameter: M6_MINOR_DIAMETER, depth, tiltAngle: 0, tiltAzimuth: 0,
        transforms: [], thread: { majorDiameter: 6, pitch: 1, length: 8 }, mark: { majorDiameter: 6, length: 8 } },
      target.shape, faces, target.origins, 'thread-1');
      return { target, result };
    } catch (error) { target.delete(); throw error; }
  }

  function faceIndices(binding: OriginBinding): readonly number[] {
    if (binding.state === 'unique') return binding.current.kind === 'face' ? [binding.current.index] : [];
    return binding.state === 'split' ? binding.candidates.filter((c) => c.kind === 'face').map((c) => c.index) : [];
  }

  function holeBindings(origins: CurrentOriginIndex | undefined, stage: 'bore' | 'thread'): readonly OriginBinding[] {
    if (origins === undefined || origins.state !== 'tracked') throw new Error('origins not tracked');
    return origins.bindings.filter((binding) => binding.origin.shapeKind === 'face' && binding.origin.identity.kind === 'hole-face'
      && binding.origin.identity.stage === stage && (stage === 'thread' || binding.origin.identity.role === 'wall'));
  }

  it.each([
    { label: '止まり', height: 20, depth: 12 },
    { label: '貫通', height: 10, depth: null },
  ])('$label: 下穴の壁は1つの split、溝は同じ穴の1つの組で、壁の隣は壁・溝・軸に直交する平面だけ', ({ height, depth }) => {
    const { target, result } = namedThread(height, depth, [[20, 15, height]], [ANCHOR]);
    try {
      const origins = result.handle.origins;
      const walls = holeBindings(origins, 'bore'), grooves = holeBindings(origins, 'thread');
      expect(walls).toHaveLength(1);
      expect(grooves).toHaveLength(1);
      const [wall] = walls, [groove] = grooves;
      if (wall === undefined || groove === undefined) throw new Error('bindings');
      expect(wall.state).toBe('split');
      expect(groove.state === 'split' || groove.state === 'unique').toBe(true);
      const wallIdentity = wall.origin.shapeKind === 'face' ? wall.origin.identity : null;
      const grooveIdentity = groove.origin.shapeKind === 'face' ? groove.origin.identity : null;
      if (wallIdentity?.kind !== 'hole-face' || grooveIdentity?.kind !== 'hole-face') throw new Error('kind');
      expect(grooveIdentity).toEqual({ kind: 'hole-face', featureId: 'thread-1', center: ANCHOR, placement: { kind: 'original' },
        stage: 'thread', role: 'groove' });
      expect(wallIdentity).toEqual({ ...grooveIdentity, stage: 'bore', role: 'wall' });
      const faces = tablesOf(result.handle.shape).faces;
      const wallFaces = faceIndices(wall), chain = new Set([...wallFaces, ...faceIndices(groove)]);
      const sides = faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? Number.NaN) - M6_MINOR_DIAMETER / 2) < 1e-9);
      expect([...wallFaces].sort((a, b) => a - b)).toEqual(sides.map((face) => face.index).sort((a, b) => a - b));
      for (const index of wallFaces) {
        const face = faces[index];
        if (face?.adjacentFaces === undefined) throw new Error(`wall ${String(index)} adjacency missing`);
        for (const neighbour of face.adjacentFaces) {
          if (chain.has(neighbour)) continue;
          const other = faces[neighbour];
          expect(other?.surfaceKind).toBe('plane');
          expect(Math.abs(other?.axis?.[2] ?? 0)).toBeCloseTo(1, 9);
        }
      }
    } finally { result.handle.delete(); target.delete(); }
  });

  it('同じフィーチャーの2つの穴が同じ錨を名乗れば、壁も溝も名前を持たない(衝突を順で選ばない)', () => {
    const { target, result } = namedThread(10, null, [[12, 15, 10], [28, 15, 10]], [ANCHOR, ANCHOR]);
    try {
      for (const binding of [...holeBindings(result.handle.origins, 'bore'), ...holeBindings(result.handle.origins, 'thread')]) {
        expect(binding.state === 'unique' || binding.state === 'split').toBe(false);
      }
    } finally { result.handle.delete(); target.delete(); }
  });

  it('別の錨の2つの穴は、それぞれの壁と溝を別々に持つ(別の穴の溝を拾わない)', () => {
    const { target, result } = namedThread(10, null, [[12, 15, 10], [28, 15, 10]], [ANCHOR, OTHER]);
    try {
      const grooves = holeBindings(result.handle.origins, 'thread');
      expect(grooves).toHaveLength(2);
      const [first, second] = grooves.map(faceIndices);
      expect(first?.some((index) => second?.includes(index))).toBe(false);
    } finally { result.handle.delete(); target.delete(); }
  });

  it('全ての面(溝の平面の端を含む)が今の隣の一覧を持ち、溝だけを削る小さなポケットは溝の面の隣に現れる', () => {
    const { target, result } = namedThread(20, 12, [[20, 15, 20]], [ANCHOR]);
    // 半径 2.75〜3.25(下穴の壁 2.46 より外)、z 13〜15 の小さな箱。下穴の壁には触れず、溝とねじ山だけを削る。
    const pocketTool = makePrimitive(oc, { kind: 'primitive', origin: [23, 15, 14], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 0.5, sizeY: 0.4, sizeZ: 2 }, originQuery: null, targetKey: null }, 'pocket');
    const cut = booleanOp(oc, 'subtract', result.handle.shape, pocketTool.shape);
    try {
      for (const shape of [result.handle.shape, cut.shape]) {
        for (const face of tablesOf(shape).faces) expect(face.adjacentFaces).toBeDefined();
      }
      const faces = tablesOf(cut.shape).faces;
      const minor = M6_MINOR_DIAMETER / 2;
      const pocketPlanes = faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
        && Math.abs(face.axis[2]) < 1e-9 && Math.abs(face.centroid[0] - 23) <= 0.26);
      expect(pocketPlanes.length).toBeGreaterThan(0);
      const touchesWall = pocketPlanes.some((plane) => (plane.adjacentFaces ?? []).some((index) => {
        const other = faces[index];
        return other?.surfaceKind === 'cylinder' && Math.abs((other.radius ?? Number.NaN) - minor) < 1e-9;
      }));
      expect(touchesWall).toBe(false);
      const touchesGroove = pocketPlanes.some((plane) => (plane.adjacentFaces ?? []).some((index) => faces[index]?.surfaceKind === 'other'));
      expect(touchesGroove).toBe(true);
    } finally { cut.delete(); pocketTool.delete(); result.handle.delete(); target.delete(); }
  });

  it('後から横に窓を切ると、壁の隣に軸と平行な平面(窓の面)が現れる', () => {
    const { target, result } = namedThread(10, null, [[20, 15, 10]], [ANCHOR]);
    const windowTool = makePrimitive(oc, { kind: 'primitive', origin: [22.4, 15, 5], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 2, sizeY: 2, sizeZ: 4 }, originQuery: null, targetKey: null }, 'window');
    const cut = booleanOp(oc, 'subtract', result.handle.shape, windowTool.shape);
    try {
      const faces = tablesOf(cut.shape).faces;
      const walls = faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? Number.NaN) - M6_MINOR_DIAMETER / 2) < 1e-9);
      const sideNeighbour = walls.some((wall) => (wall.adjacentFaces ?? []).some((index) => {
        const other = faces[index];
        return other?.surfaceKind === 'plane' && other.axis !== null && Math.abs(other.axis[2]) < 1e-9;
      }));
      expect(sideNeighbour).toBe(true);
    } finally { cut.delete(); windowTool.delete(); result.handle.delete(); target.delete(); }
  });
});
