import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { CurrentOriginIndex, SubShapeOrigin } from '../subShapeOrigin.js';
import type { CurveSpec, RigidTransformSpec, SolidBodyMesh, SolidRecomputeResult, SolidStepRequest, SolidStepSpec, SubShapeQuery,
  Vec3Tuple } from '../types.js';
import { recomputeSolids, type CachedSolid } from '../worker/recomputeSolids.js';
import { createShapeCache, type ShapeCache } from '../worker/shapeCache.js';
import { booleanPattern } from './booleanPattern.js';
import { lookupSubShapeOrigin } from './composeSubShapeOrigins.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { measureVolume } from './solidMesh.js';

/**
 * 並べる和・差(M-04 の計算部 kernel-1)。期待の体積は手で出した値(M-04 の model の候補が独立に出した値と同じ)。
 * 板の体積 50×50×10 = 25,000、ボス・角穴は 2×2×3 = 12。
 */
const RELATIVE = 1e-9;

function rectangleAt(x: number, y: number, z: number, width: number, depth: number): readonly CurveSpec[] {
  return [
    { kind: 'segment', from: [x, y, z], to: [x + width, y, z] },
    { kind: 'segment', from: [x + width, y, z], to: [x + width, y + depth, z] },
    { kind: 'segment', from: [x + width, y + depth, z], to: [x, y + depth, z] },
    { kind: 'segment', from: [x, y + depth, z], to: [x, y, z] },
  ];
}

function step(id: string, spec: SolidStepSpec, visible = false): SolidStepRequest {
  return { key: `key-${id}`, id, label: id, visible, step: spec };
}

function box(id: string, x: number, y: number, z: number, width: number, depth: number, height: number): SolidStepRequest {
  return step(id, { kind: 'extrude', profile: rectangleAt(x, y, z, width, depth), direction: [0, 0, 1], distance: height });
}

/** 基本形状の直方体(中心が center)。基本形状は名前の継ぎを持つ。 */
function primitiveCuboid(id: string, center: Vec3Tuple, sizeX: number, sizeY: number, sizeZ: number): SolidStepRequest {
  return step(id, { kind: 'primitive', origin: center, axis: [0, 0, 1], shape: { kind: 'box', sizeX, sizeY, sizeZ },
    originQuery: null, targetKey: null });
}

/** 名前の継ぎのある板(50×50×10、隅が原点)に、名前の継ぎのある 2×2×height のボスを半径 13 の位置で和にした所まで。 */
function namedPlateWithBoss(height: number): readonly SolidStepRequest[] {
  return [primitiveCuboid('plate', [25, 25, 5], 50, 50, 10), primitiveCuboid('boss', [38, 25, 10 + height / 2], 2, 2, height),
    combine('first', 'union', 'plate', 'boss', { visible: false })];
}

/** 板の縦の辺のうち、原点の隅(0, 0)にある長さ 10 の辺の指紋に、その辺の名前を添える。 */
function cornerEdgeQuery(body: SolidBodyMesh): Extract<SubShapeQuery, { kind: 'edge' }> {
  const edge = body.edges.find(item => item.curveKind === 'line' && Math.abs(item.length - 10) < 1e-9
    && Math.abs(item.midpoint[0]) < 1e-9 && Math.abs(item.midpoint[1]) < 1e-9);
  const origins = body.origins;
  if (edge === undefined || origins?.state !== 'tracked') throw new Error('隅の辺か名前の継ぎがありません');
  const binding = origins.bindings.find(item => item.state === 'unique' && item.current.kind === 'edge' && item.current.index === edge.index);
  if (binding === undefined) throw new Error('隅の辺の名前がありません');
  return { kind: 'edge', index: edge.index, curveKind: edge.curveKind, length: edge.length, position: edge.midpoint, axis: edge.axis,
    radius: edge.radius, origin: binding.origin };
}

function uniqueOrigins(origins: CurrentOriginIndex | undefined): readonly SubShapeOrigin[] {
  return origins?.state === 'tracked' ? origins.bindings.filter(item => item.state === 'unique').map(item => item.origin) : [];
}

function primitiveBox(id: string, center: Vec3Tuple, size: number): SolidStepRequest {
  return step(id, { kind: 'primitive', origin: center, axis: [0, 0, 1], shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size },
    originQuery: null, targetKey: null });
}

function combine(id: string, operation: 'union' | 'subtract' | 'intersect', target: string, tool: string,
  extra: { readonly transforms?: readonly RigidTransformSpec[]; readonly visible?: boolean } = {}): SolidStepRequest {
  return step(id, { kind: 'boolean', operation, targetKey: `key-${target}`, toolKey: `key-${tool}`,
    ...(extra.transforms === undefined ? {} : { transforms: extra.transforms }) }, extra.visible ?? true);
}

function translation(x: number, y: number, z: number): RigidTransformSpec {
  return { translation: [x, y, z], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 };
}

/** 板の中心(25, 25)を通る Z 軸まわりに、全周を count 等分した k 番目(k = 1..count-1)。 */
function circularCopies(count: number): readonly RigidTransformSpec[] {
  return Array.from({ length: count - 1 }, (_, index) => ({ translation: [0, 0, 0] as Vec3Tuple, rotationOrigin: [25, 25, 0] as Vec3Tuple,
    rotationAxis: [0, 0, 1] as Vec3Tuple, rotationAngle: (2 * Math.PI * (index + 1)) / count }));
}

/** 50×50×10 の板の上に、中心から半径 13 の位置へ 2×2×height のボスを 1 つ載せて和にした所まで。 */
function plateWithBoss(height: number): readonly SolidStepRequest[] {
  return [box('plate', 0, 0, 0, 50, 50, 10), box('boss', 37, 24, 10, 2, 2, height), combine('first', 'union', 'plate', 'boss', { visible: false })];
}

function relativeDifference(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe('並べる和・差は、工具の写しを 1 回で組み合わせ、対象の名前を継ぐ(M-04 の計算部 kernel-1・kernel-2)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  const openCaches: ShapeCache<CachedSolid>[] = [];

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  afterEach(() => {
    for (const cache of openCaches.splice(0)) cache.clear();
  });

  function newCache(): ShapeCache<CachedSolid> {
    const cache = createShapeCache<CachedSolid>();
    openCaches.push(cache);
    return cache;
  }

  async function run(steps: readonly SolidStepRequest[], cache = newCache()): Promise<SolidRecomputeResult> {
    return recomputeSolids({ oc, cache }, { steps, generation: 1 });
  }

  async function onlyVolume(steps: readonly SolidStepRequest[]): Promise<number> {
    const result = await run(steps);
    expect(result.failures).toEqual([]);
    expect(result.bodies).toHaveLength(1);
    const [body] = result.bodies;
    if (body === undefined) throw new Error('ボディがありません');
    expect(body.bodyKind).toBe('solid');
    return body.volume;
  }

  it('円形 20 個: 板にボス 20 個(写し 19 個を 1 回で和)は 25,240 mm³、ボスの高さ 4 なら 25,320 mm³', async () => {
    const volume3 = await onlyVolume([...plateWithBoss(3), combine('pattern', 'union', 'first', 'boss', { transforms: circularCopies(20) })]);
    expect(relativeDifference(volume3, 25_240)).toBeLessThanOrEqual(RELATIVE);
    const volume4 = await onlyVolume([...plateWithBoss(4), combine('pattern', 'union', 'first', 'boss', { transforms: circularCopies(20) })]);
    expect(relativeDifference(volume4, 25_320)).toBeLessThanOrEqual(RELATIVE);
  });

  it('直線 5 個: 板から深さ 3 の 2×2 を間隔 8 で 5 個削る(写し 4 個を 1 回で差)と 24,940 mm³', async () => {
    const volume = await onlyVolume([box('plate', 0, 0, 0, 50, 50, 10), box('pocket', 5, 24, 7, 2, 2, 4),
      combine('first', 'subtract', 'plate', 'pocket', { visible: false }),
      combine('pattern', 'subtract', 'first', 'pocket', { transforms: [8, 16, 24, 32].map(x => translation(x, 0, 0)) })]);
    expect(relativeDifference(volume, 24_940)).toBeLessThanOrEqual(RELATIVE);
  });

  it('単独の立体を自分の写しと和: 40×30×10 の箱を間隔 10 で 3 個重ねると 60×30×10 = 18,000 mm³', async () => {
    const volume = await onlyVolume([box('block', 0, 0, 0, 40, 30, 10),
      combine('pattern', 'union', 'block', 'block', { transforms: [translation(10, 0, 0), translation(20, 0, 0)] })]);
    expect(relativeDifference(volume, 18_000)).toBeLessThanOrEqual(RELATIVE);
  });

  it('写し 0 個は対象をそのまま引き継ぐ(体積・面の数・名前の継ぎが対象と同じ)', async () => {
    const cache = newCache();
    const result = await run([primitiveBox('cube', [0, 0, 0], 20), combine('pattern', 'union', 'cube', 'cube', { transforms: [] })], cache);
    expect(result.failures).toEqual([]);
    const target = cache.get('key-cube'), carried = cache.get('key-pattern');
    if (target === undefined || carried === undefined) throw new Error('キャッシュに形がありません');
    expect(carried.mesh.volume).toBe(target.mesh.volume);
    expect(carried.mesh.faceCount).toBe(target.mesh.faceCount);
    expect(carried.mesh.origins?.state).toBe('tracked');
    expect(carried.mesh.origins).toEqual(target.mesh.origins);
    expect(carried.shape.IsSame(target.shape)).toBe(false);
  });

  it('写しが対象から離れた和は、理由を出して断る(直前の段は残る)', async () => {
    const result = await run([...plateWithBoss(3), combine('pattern', 'union', 'first', 'boss', { transforms: [translation(100, 0, 0)] })]);
    expect(result.failures).toEqual([{ id: 'pattern', message: '並べた立体の一部が、元の立体から離れています。間隔や個数を見直してください。' }]);
  });

  it('変換に数でない値があれば、今の並べると同じ文で断る', async () => {
    const result = await run([...plateWithBoss(3),
      combine('pattern', 'union', 'first', 'boss', { transforms: [translation(Number.NaN, 0, 0)] })]);
    expect(result.failures.map(failure => failure.message)).toEqual(['並べる位置や角度が数になっていません。']);
  });

  it('対象・工具のキャッシュの形に触れない。同じ依頼の 2 回目は全部の段が当たる', async () => {
    const cache = newCache();
    const steps = [...plateWithBoss(3), combine('pattern', 'union', 'first', 'boss', { transforms: circularCopies(20) })];
    const first = await run(steps, cache);
    expect(first.failures).toEqual([]);
    const target = cache.get('key-first'), tool = cache.get('key-boss');
    if (target === undefined || tool === undefined) throw new Error('キャッシュに形がありません');
    expect(relativeDifference(measureVolume(oc, target.shape), 25_012)).toBeLessThanOrEqual(RELATIVE);
    expect(relativeDifference(measureVolume(oc, tool.shape), 12)).toBeLessThanOrEqual(RELATIVE);
    const second = await run(steps, cache);
    expect(second.cacheHits).toBe(steps.length);
    expect(second.bodies.map(body => body.volume)).toEqual(first.bodies.map(body => body.volume));
  });

  it('model の約束を破った依頼(積・何も削れない差の欄・写し 100 個)は RangeError で止める', async () => {
    const cache = newCache();
    const result = await run([box('plate', 0, 0, 0, 50, 50, 10), box('boss', 37, 24, 10, 2, 2, 3)], cache);
    expect(result.failures).toEqual([]);
    const plate = cache.get('key-plate'), boss = cache.get('key-boss');
    if (plate === undefined || boss === undefined) throw new Error('キャッシュに形がありません');
    const one = [translation(1, 0, 0)];
    const target = { shape: plate.shape, origins: undefined };
    expect(() => booleanPattern(oc, { operation: 'intersect' }, one, target, boss.shape)).toThrow(RangeError);
    expect(() => booleanPattern(oc, { operation: 'subtract', requireRemoval: true }, one, target, boss.shape)).toThrow(RangeError);
    const hundred = Array.from({ length: 100 }, (_, index) => translation(0, 0, index + 1));
    expect(() => booleanPattern(oc, { operation: 'union' }, hundred, target, boss.shape)).toThrow(RangeError);
  });

  it('写しが 1 個以上でも、対象から来た物の名前は全部継ぎ、写しから来た物には名前を付けない', async () => {
    const cache = newCache();
    const result = await run([...namedPlateWithBoss(3), combine('pattern', 'union', 'first', 'boss', { transforms: circularCopies(20) })],
      cache);
    expect(result.failures).toEqual([]);
    const target = cache.get('key-first'), patterned = cache.get('key-pattern');
    if (target === undefined || patterned === undefined) throw new Error('キャッシュに形がありません');
    expect(target.mesh.origins?.state).toBe('tracked');
    expect(patterned.mesh.origins?.state).toBe('tracked');
    const named = uniqueOrigins(target.mesh.origins);
    expect(named.length).toBeGreaterThan(0);
    expect(named.map(origin => lookupSubShapeOrigin(patterned.mesh.origins, origin).status)).toEqual(named.map(() => 'matched'));
    // 名前は対象の分だけ(写し 19 個の面・辺・頂点に新しい名前を作らない)。
    const targetCount = target.mesh.origins?.state === 'tracked' ? target.mesh.origins.bindings.length : -1;
    expect(patterned.mesh.origins?.state === 'tracked' ? patterned.mesh.origins.bindings.length : -2).toBe(targetCount);
    expect(patterned.mesh.faceCount).toBeGreaterThan(target.mesh.faceCount);
  });

  it('並べた後の板の隅の辺を名前つきで R 面取りでき、ボスの高さを変えて作り直しても同じ辺に当たる', async () => {
    const pattern = (): SolidStepRequest => combine('pattern', 'union', 'first', 'boss', { transforms: circularCopies(20), visible: false });
    const source = await run([...namedPlateWithBoss(3), combine('pattern', 'union', 'first', 'boss', { transforms: circularCopies(20) })]);
    const [body] = source.bodies;
    if (body === undefined) throw new Error('ボディがありません');
    const query = cornerEdgeQuery(body);
    const fillet = (): SolidStepRequest => step('round', { kind: 'fillet', targetKey: 'key-pattern', targets: [query], radius: 2 }, true);
    // R2 の角を 1 本丸めると、(1 − π/4)·2²·10 だけ減る。
    const removed = (1 - Math.PI / 4) * 4 * 10;
    const volume3 = await onlyVolume([...namedPlateWithBoss(3), pattern(), fillet()]);
    expect(relativeDifference(volume3, 25_240 - removed)).toBeLessThanOrEqual(1e-7);
    const volume4 = await onlyVolume([...namedPlateWithBoss(4), pattern(), fillet()]);
    expect(relativeDifference(volume4, 25_320 - removed)).toBeLessThanOrEqual(1e-7);
  });
});
