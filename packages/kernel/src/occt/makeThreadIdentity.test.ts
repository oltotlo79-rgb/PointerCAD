import { beforeAll, describe, expect, it } from 'vitest';

import type { CurrentOriginIndex } from '../subShapeOrigin.js';
import type { SolidFaceInfo, SubShapeQuery, ThreadStepSpec } from '../types.js';
import { lookupSubShapeOrigin } from './composeSubShapeOrigins.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { makeThreadHole } from './makeThread.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** M6 並目のめねじ内径 D1(makeThread.test.ts と同じく model を輸入せずに独立に計算する)。 */
const M6_MINOR_DIAMETER = 6 - 1.0825317547305482;
const FEATURE = 'thread-identity';

function anchor(pointFeatureId: string): NonNullable<ThreadStepSpec['centerAnchors']>[number] {
  return { sketchId: 'sketch-1', producer: { kind: 'point', featureId: pointFeatureId } };
}

describe('ねじ穴の下穴の壁に、穴と同じ由来を付ける(hole-identity-r1)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  function tablesOf(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return { kind: 'face', index: info.index, surfaceKind: info.surfaceKind, area: info.area,
      position: info.centroid, axis: info.axis, radius: info.radius };
  }

  /** 40×30×10 の板(上の面 z=10)。makeThread.test.ts の「target-only history」と同じ実 Box 起点。 */
  function plate() {
    const target = makePrimitive(oc, { kind: 'primitive', origin: [20, 15, 5], axis: [0, 0, 1],
      shape: { kind: 'box', sizeX: 40, sizeY: 30, sizeZ: 10 }, originQuery: null, targetKey: null }, 'thread-plate');
    if (target.origins?.state !== 'tracked') throw new Error('target proof missing');
    const faces = tablesOf(target.shape).faces;
    const top = faces.find((face) => face.surfaceKind === 'plane' && face.axis !== null && Math.abs(face.axis[2] - 1) < 1e-9);
    if (top === undefined) throw new Error('top face missing');
    const binding = target.origins.bindings.find((item) => item.state === 'unique'
      && item.current.kind === 'face' && item.current.index === top.index);
    if (binding === undefined || binding.origin.shapeKind !== 'face') throw new Error('top proof missing');
    return { target, origins: target.origins, faces, face: { ...faceQuery(top), origin: binding.origin } };
  }

  function spec(overrides: Partial<ThreadStepSpec> & { face: SubShapeQuery }): ThreadStepSpec {
    return { kind: 'thread', targetKey: 'target', centers: [[20, 15, 10]], drillDiameter: M6_MINOR_DIAMETER, depth: null,
      tiltAngle: 0, tiltAzimuth: 0, transforms: [], thread: null, mark: { majorDiameter: 6, length: 10 }, ...overrides };
  }

  /** 由来の表で、今の番地を unique に主張する下穴の壁(bore/wall)を、中心の生成元ごとに引く。 */
  function wallsByPoint(handle: { readonly origins?: CurrentOriginIndex }, tables: SubShapeTables): Map<string, SolidFaceInfo> {
    const origins = handle.origins;
    if (origins?.state !== 'tracked') throw new Error('result proof missing');
    const found = new Map<string, SolidFaceInfo>();
    for (const binding of origins.bindings) {
      if (binding.state !== 'unique' || binding.origin.shapeKind !== 'face') continue;
      const identity = binding.origin.identity;
      if (identity.kind !== 'hole-face' || identity.stage !== 'bore' || identity.role !== 'wall') continue;
      expect(identity.featureId).toBe(FEATURE);
      const face = tables.faces.find((entry) => entry.index === binding.current.index);
      if (face === undefined || identity.center.producer.kind !== 'point') throw new Error('wall face missing');
      expect(found.has(identity.center.producer.featureId)).toBe(false);
      found.set(identity.center.producer.featureId, face);
    }
    return found;
  }

  it('簡略表示: 離れた同径の2つの下穴の壁は、それぞれ自分の中心の由来を持つ', () => {
    const { target, origins, faces, face } = plate();
    try {
      const result = makeThreadHole(oc, spec({ face, centers: [[8, 15, 10], [30, 15, 10]],
        centerAnchors: [anchor('point-a'), anchor('point-b')], placementRoles: [] }), target.shape, faces, origins, FEATURE);
      try {
        const tables = tablesOf(result.handle.shape);
        const walls = wallsByPoint(result.handle, tables);
        expect([...walls.keys()].sort()).toEqual(['point-a', 'point-b']);
        // 独立の期待: 壁の軸は中心の x を通り、半径は下穴の半径。
        for (const [point, x] of [['point-a', 8], ['point-b', 30]] as const) {
          const wall = walls.get(point);
          expect(wall?.surfaceKind).toBe('cylinder');
          expect(Math.abs((wall?.radius ?? NaN) - M6_MINOR_DIAMETER / 2)).toBeLessThan(1e-7);
          expect(Math.abs((wall?.axisOrigin?.[0] ?? NaN) - x)).toBeLessThan(1e-7);
          expect(Math.abs((wall?.axisOrigin?.[1] ?? NaN) - 15)).toBeLessThan(1e-7);
        }
        expect(isValidShape(oc, result.handle.shape)).toBe(true);
        expect(Math.abs(measureVolume(oc, result.handle.shape) - (12000 - 2 * Math.PI * (M6_MINOR_DIAMETER / 2) ** 2 * 10)))
          .toBeLessThan(1e-6);
        // 古い・別の生成元の由来は、今の結果では見つからない。
        const someWall = walls.get('point-a');
        if (someWall === undefined || result.handle.origins?.state !== 'tracked') throw new Error('wall missing');
        // 番地は { kind, index }。同じ番号の辺・頂点の binding を取らないよう、面の番地で引く。
        const own = result.handle.origins.bindings.find((item) => item.state === 'unique' && item.current.kind === 'face'
          && item.current.index === someWall.index && item.origin.shapeKind === 'face' && item.origin.identity.kind === 'hole-face');
        if (own === undefined || own.origin.shapeKind !== 'face' || own.origin.identity.kind !== 'hole-face') throw new Error('own missing');
        expect(lookupSubShapeOrigin(result.handle.origins, own.origin).status).toBe('matched');
        expect(lookupSubShapeOrigin(result.handle.origins,
          { ...own.origin, identity: { ...own.origin.identity, featureId: 'stale-feature' } }).status).toBe('missing');
      } finally { result.handle.delete(); }
    } finally { target.delete(); }
  });

  it('名前の材料が無ければ今までどおり名前なし(既存の段・由来を変えない)', () => {
    const { target, origins, faces, face } = plate();
    try {
      const result = makeThreadHole(oc, spec({ face }), target.shape, faces, origins, FEATURE);
      try {
        if (result.handle.origins?.state !== 'tracked') throw new Error('result proof missing');
        expect(result.handle.origins.bindings.some((item) => item.origin.identity.featureId === FEATURE)).toBe(false);
      } finally { result.handle.delete(); }
    } finally { target.delete(); }
  });

  it('中心の生成元の数が中心と合わなければ、名前を作らずに断る(壊れた証明を採らない)', () => {
    const { target, origins, faces, face } = plate();
    try {
      expect(() => makeThreadHole(oc, spec({ face, centerAnchors: [anchor('point-a'), anchor('point-b')], placementRoles: [] }),
        target.shape, faces, origins, FEATURE)).toThrow(/Hole producer roles do not match the operation/u);
    } finally { target.delete(); }
  });

  // 診断(実らせんの支持を検証するものではない): 部分長の実らせんで全周と認められる帯が何本あるかは native の形で
  // 決まり、0 本なら下の「どれも名前を持つ」は空になる。log の本数を Root が読む。必須の期待は、名前を付けても
  // 形と帯の判定が名前なしの対照と同じで、認められた帯を黙って名前なしにしないことだけ。
  it('診断: 実らせんの部分長で、名前を付けても形と帯の判定は変わらず、認められた帯は名前を持つ', () => {
    const { target, origins, faces, face } = plate();
    try {
      const named = makeThreadHole(oc, spec({ face, thread: { majorDiameter: 6, pitch: 1, length: 2 },
        centerAnchors: [anchor('point-a')], placementRoles: [] }), target.shape, faces, origins, FEATURE);
      const control = makeThreadHole(oc, spec({ face, thread: { majorDiameter: 6, pitch: 1, length: 2 } }),
        target.shape, faces, origins, FEATURE);
      try {
        // 名前を付けても形は変えない。
        expect(Math.abs(measureVolume(oc, named.handle.shape) - measureVolume(oc, control.handle.shape))).toBeLessThan(1e-6);
        expect(isValidShape(oc, named.handle.shape)).toBe(true);
        const tables = tablesOf(named.handle.shape);
        const certified = tables.faces.filter((entry) => entry.surfaceKind === 'cylinder'
          && Math.abs((entry.radius ?? NaN) - M6_MINOR_DIAMETER / 2) < 1e-7 && entry.cylinderSpan != null);
        // 親(名前なし)でも同じ帯が全周と認められていること(帯の判定そのものは変えていない)。
        const controlCertified = tablesOf(control.handle.shape).faces.filter((entry) => entry.surfaceKind === 'cylinder'
          && Math.abs((entry.radius ?? NaN) - M6_MINOR_DIAMETER / 2) < 1e-7 && entry.cylinderSpan != null);
        expect(certified.length).toBe(controlCertified.length);
        console.log('THREAD_IDENTITY_PARTIAL_BAND_DIAGNOSTIC', JSON.stringify({ certified: certified.length,
          note: 'diagnostic only; does not validate modeled thread support' }));
        // 追跡できる板の上では、付け直しに失敗しない限り由来を保つ(makeThread.test.ts の modeled と同じ前提)。
        const walls = wallsByPoint(named.handle, tables);
        for (const band of certified) {
          expect([...walls.values()].some((wall) => wall.index === band.index)).toBe(true);
        }
      } finally { control.handle.delete(); named.handle.delete(); }
    } finally { target.delete(); }
  });
});
