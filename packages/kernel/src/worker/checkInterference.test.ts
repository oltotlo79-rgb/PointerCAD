import { readFileSync } from 'node:fs';
import type { Bnd_Box, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createSourceFile, forEachChild, isTypePredicateNode, ScriptKind, ScriptTarget, type Node } from 'typescript';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InterferenceComponentSpec, InterferenceRequest, InterferenceResult, PlacementSpec } from '../types.js';
import * as allocationModule from '../occt/allocations.js';
import type { Allocations, OcctDeletable } from '../occt/allocations.js';
import * as booleanModule from '../occt/booleanOp.js';
import * as commonModule from '../occt/intersectionVolume.js';
import * as meshModule from '../occt/exportMesh.js';
import * as placementModule from '../occt/placeBodies.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeBox } from '../occt/makeBox.js';
import { buildSolidBodyMesh, isValidShape, measureVolume } from '../occt/solidMesh.js';
import { checkInterference, certifyInterferenceBox, conservativeBodyBounds, conservativeWorldBounds, interferenceTranslationDeltaUpper } from './checkInterference.js';
import type { CachedSolid } from './recomputeSolids.js';

let oc: OpenCascadeInstance;
let fixtures: Allocations;
let bodies: Map<string, CachedSolid>;
const identity: PlacementSpec = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

function captureMethod<T extends object, K extends keyof T>(object: T, key: K): T[K] { return object[key]; }

/** コメント/名前の一致ではなく、全ての関数形式に現れる述語戻り型をASTから拾う。 */
function predicateReturnTypes(source: string): string[] {
  const file = createSourceFile('checkInterference.ts', source, ScriptTarget.Latest, true, ScriptKind.TS);
  const predicates: string[] = [];
  function visit(node: Node): void {
    if (isTypePredicateNode(node)) predicates.push(node.getText(file));
    forEachChild(node, visit);
  }
  visit(file);
  return predicates;
}

function ready(id: string, keys: readonly string[], x = 0, placement?: PlacementSpec): InterferenceComponentSpec {
  return { kind: 'ready', componentId: id, bodyKeys: keys, placement: placement ?? { ...identity, position: [x, 0, 0] } };
}
function request(components = [ready('a', ['box']), ready('b', ['box'], 15)]): InterferenceRequest {
  return { requestId: 'generation:25', components };
}
function addBox(key: string, size = 20, x = 0): CachedSolid {
  const box = fixtures.keep(makeBox(oc, { dx: size, dy: size, dz: size }));
  const handle = fixtures.keep(placementModule.placeShape(oc, box.shape, { ...identity, position: [x, 0, 0] }));
  const entry = { shape: handle.shape, mesh: buildSolidBodyMesh(oc, key, handle.shape), delete: () => undefined };
  bodies.set(key, entry);
  return entry;
}
function addWedge(): CachedSolid {
  const shape = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeWedge_1(20, 20, 20, 10)).Shape());
  const entry = { shape, mesh: buildSolidBodyMesh(oc, 'wedge', shape), delete: () => undefined };
  bodies.set('wedge', entry); return entry;
}
function accounting(result: InterferenceResult): void {
  expect(result.totalPairCount).toBe(result.checkedPairCount + result.skippedPairCount + result.failures.length + result.pendingPairCount);
  expect(result.pairs.length).toBeLessThanOrEqual(result.checkedPairCount);
}
function volume(result: InterferenceResult, expected: number, tolerance = 1e-6): void {
  accounting(result);
  expect(result.kind).toBe('checked');
  expect(result.failures).toEqual([]);
  expect(result.pairs).toHaveLength(1);
  expect(Math.abs(result.pairs[0].volume - expected)).toBeLessThanOrEqual(tolerance);
  expect(result.pairs[0].mesh.triangleCount).toBeGreaterThan(0);
}
function metrics(shape: TopoDS_Shape) {
  const scope = allocationModule.createAllocations();
  try {
    const map = scope.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const types = [];
    for (let index = 1; index <= map.Size(); index += 1) types.push(scope.keep(map.FindKey(index)).ShapeType());
    const box = scope.keep(conservativeBodyBounds(oc, shape));
    return { volume: measureVolume(oc, shape), valid: isValidShape(oc, shape), types,
      bounds: placementModule.boundingBoxRange(box) };
  } finally { scope.release(); }
}
function observe() {
  const entries: { item: OcctDeletable; deletes: number }[] = [];
  const seen = new Set<OcctDeletable>();
  function track<T extends OcctDeletable>(item: T): T {
    if (seen.has(item)) return item;
    seen.add(item);
    const entry = { item, deletes: 0 }; entries.push(entry);
    const release = item.delete.bind(item);
    item.delete = () => { entry.deletes += 1; release(); };
    return item;
  }
  const create = allocationModule.createAllocations;
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const scope = create();
    return { keep<T extends OcctDeletable>(item: T): T { return scope.keep(track(item)); }, release: scope.release };
  });
  const Box = oc.Bnd_Box_1;
  vi.spyOn(oc, 'Bnd_Box_1').mockImplementation(function () { return track(new Box()); });
  return { entries, expectReleased() { expect(entries.length).toBeGreaterThan(0); expect(entries.filter((entry) => entry.deletes !== 1)).toEqual([]); } };
}

beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
beforeEach(() => { fixtures = allocationModule.createAllocations(); bodies = new Map(); addBox('box'); });
afterEach(() => { vi.restoreAllMocks(); fixtures.release(); });

describe('部品単位の非破壊干渉解析', () => {
  it('K62 workerの全関数形式に未承認の型述語戻り型を追加しない', () => {
    const source = readFileSync(new URL('./checkInterference.ts', import.meta.url), 'utf8');
    expect(predicateReturnTypes(source)).toEqual([]);
  });
  it('K63 静的ゲートは宣言・arrow・method・関数型のisを検出しコメントやbooleanと区別する', () => {
    for (const source of [
      'function inspect(x: unknown): x is number { return typeof x === "number"; }',
      'const inspect = (x: unknown): x is number => typeof x === "number";',
      'const object = { inspect(x: unknown): x is number { return typeof x === "number"; } };',
      'type Inspect = (x: unknown) => x is number;',
      'interface Inspect { (x: unknown): x is number; }',
    ]) expect(predicateReturnTypes(source)).toEqual(['x is number']);
    expect(predicateReturnTypes('// x is number\nfunction inspect(x: unknown): boolean { return typeof x === "number"; }')).toEqual([]);
  });
  it.each([0, 1, 2])('K59 第%s軸へ移した認証済み非立方体はGlueShiftを使い、実Commonと直接作った世界meshを保つ', async (axis) => {
    const dimensions = [7.5, 11, 17.25];
    const handle = fixtures.keep(makeBox(oc, { dx: dimensions[0], dy: dimensions[1], dz: dimensions[2] }));
    const source = fixtures.keep(placementModule.placeShape(oc, handle.shape, { ...identity, position: [-3, 2, 4] }));
    bodies.set('prism', { shape: source.shape, mesh: buildSolidBodyMesh(oc, 'prism', source.shape), delete() {} });
    const first: PlacementSpec = { ...identity, position: [-20, 31, 12] };
    const second: PlacementSpec = { ...identity, position: [first.position[0] + (axis === 0 ? 1.25 : 0), first.position[1] + (axis === 1 ? 1.25 : 0), first.position[2] + (axis === 2 ? 1.25 : 0)] };
    const glue = vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetGlue');
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const mesh = vi.spyOn(meshModule, 'buildExportMesh');
    const before = metrics(source.shape); const tracked = observe();
    const result = await checkInterference(request([ready('a', ['prism'], 0, first), ready('b', ['prism'], 0, second)]), oc, bodies);
    volume(result, dimensions.reduce((product, size, index) => product * (size - (index === axis ? 1.25 : 0)), 1));
    expect(glue).toHaveBeenCalledExactlyOnceWith(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    expect(common).toHaveBeenCalledTimes(1); expect(mesh).not.toHaveBeenCalled();
    tracked.expectReleased(); expect(metrics(source.shape)).toEqual(before);
    expect(result.pairs[0].mesh).toMatchObject({ triangleCount: 12 });
    expect(result.pairs[0].mesh.positions).toHaveLength(72);
    expect(result.pairs[0].mesh.normals).toHaveLength(72);
    expect(result.pairs[0].mesh.indices).toHaveLength(36);
    expect(Math.max(...result.pairs[0].mesh.indices)).toBe(23);
    const localOrigin = [-3, 2, 4];
    for (let coordinate = 0; coordinate < 3; coordinate += 1) {
      const positions = [...result.pairs[0].mesh.positions].filter((_, index) => index % 3 === coordinate);
      expect(Math.min(...positions)).toBe(first.position[coordinate] + localOrigin[coordinate] + (axis === coordinate ? 1.25 : 0));
      expect(Math.max(...positions)).toBe(first.position[coordinate] + localOrigin[coordinate] + dimensions[coordinate]);
    }
  });

  it('K01 離れた2箱はAABBだけでcheckedとなりCommon/meshを呼ばない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const mesh = vi.spyOn(meshModule, 'buildExportMesh');
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 50)]), oc, bodies);
    expect(result).toMatchObject({ totalPairCount: 1, checkedPairCount: 1, pendingPairCount: 0, pairs: [] });
    expect(common).not.toHaveBeenCalled(); expect(mesh).not.toHaveBeenCalled(); accounting(result);
  });
  it.each(['multiAxis', 'nearAxis', 'rotation', 'wedge', 'inverted', 'contact', 'nearContact', 'nearCoincident', 'identical', 'threshold', 'largeCoordinate', 'differentShape'] as const)(
    'K60 GlueShiftの十分条件を証明できない%sはoption省略controlと結果・所有が一致する', async (kind) => {
      let key = 'box'; let otherKey = key;
      let first: PlacementSpec = identity; let second: PlacementSpec = { ...identity, position: [2, 0, 0] };
      if (kind === 'multiAxis') second = { ...identity, position: [2, 3, 0] };
      if (kind === 'nearAxis') second = { ...identity, position: [2, 1e-12, 0] };
      if (kind === 'rotation') {
        const rotation: PlacementSpec['rotation'] = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
        first = { ...first, rotation }; second = { ...second, rotation };
      }
      if (kind === 'wedge') { addWedge(); key = 'wedge'; otherKey = key; }
      if (kind === 'inverted') {
        const original = bodies.get(key); if (original === undefined) throw new Error('fixture');
        const shape = fixtures.keep(original.shape.Reversed());
        key = 'inverted'; otherKey = key;
        bodies.set(key, { shape, mesh: buildSolidBodyMesh(oc, key, shape), delete() {} });
      }
      if (kind === 'contact') second = { ...identity, position: [20, 0, 0] };
      if (kind === 'nearContact') second = { ...identity, position: [20 - 5e-7, 0, 0] };
      if (kind === 'nearCoincident') second = { ...identity, position: [5e-7, 0, 0] };
      if (kind === 'identical') second = identity;
      if (kind === 'threshold') { addBox('tiny', 0.01); key = 'tiny'; otherKey = key; second = { ...identity, position: [0.009, 0, 0] }; }
      if (kind === 'largeCoordinate') { first = { ...identity, position: [1e10, 0, 0] }; second = { ...identity, position: [1e10 + 2, 0, 0] }; }
      if (kind === 'differentShape') { addBox('copy'); otherKey = 'copy'; }
      const glue = vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetGlue');
      const inverted = vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetCheckInverted');
      const tracked = observe();
      const input = request([ready('a', [key], 0, first), ready('b', [otherKey], 0, second)]);
      // 境界入力の成功を仮定しない。先に実Commonのoptionを省略したcontrolを作る。
      // 同じworker・実mesh・所有経路を通し、nativeの結果や例外を置換しない。
      const nativeCommon = captureMethod(commonModule, 'intersectionVolume');
      const controlCommon = vi.spyOn(commonModule, 'intersectionVolume').mockImplementation((kernel, a, b) => nativeCommon(kernel, a, b));
      const control = await checkInterference(input, oc, bodies);
      expect(controlCommon).toHaveBeenCalledTimes(1); expect(glue).not.toHaveBeenCalled();
      accounting(control); tracked.expectReleased(); controlCommon.mockRestore();
      const common = vi.spyOn(commonModule, 'intersectionVolume');
      const result = await checkInterference(input, oc, bodies);
      expect(common).toHaveBeenCalledTimes(1); expect(glue).not.toHaveBeenCalled();
      expect(inverted).not.toHaveBeenCalled();
      // status、clear/失敗理由、体積、world mesh、件数をcontrolと全て比べる。
      expect(result).toEqual(control);
      accounting(result); tracked.expectReleased();
    },
  );
  it('K61 GlueShiftのpair設定失敗でも次の組を調べ、所有と件数を戻す', async () => {
    vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetGlue').mockImplementationOnce(() => { throw new Error('pair glue setup'); });
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const tracked = observe();
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 15), ready('c', ['box'], 30)]), oc, bodies);
    expect(result.kind).toBe('checked'); expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ pair: ['a', 'b'], stage: 'common', code: 'occtException', detail: 'pair glue setup' });
    expect(result.pairs).toHaveLength(1); expect(result.pairs[0]).toMatchObject({ aComponentId: 'b', bComponentId: 'c' });
    expect(common).toHaveBeenCalledTimes(2); expect(result.checkedPairCount).toBe(2);
    accounting(result); tracked.expectReleased();
  });
  it('K02 面接触を候補としてCommonへ渡し体積干渉にしない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 20)]), oc, bodies);
    expect(common).toHaveBeenCalledTimes(1); expect(result.pairs).toEqual([]); expect(result.checkedPairCount).toBe(1);
  });
  it('K03 完全包含を表面交差なしで捨てない', async () => {
    addBox('small', 10); volume(await checkInterference(request([ready('a', ['box']), ready('b', ['small'], 5)]), oc, bodies), 1000);
  });
  it('K04 0.001mmの薄い侵入を失わない', async () => {
    volume(await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 19.999)]), oc, bodies), 0.4, 1e-8);
  });
  it('K05 実入力の1e-4公差へ余白を加算し公差を縮めない', () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    const builder = fixtures.keep(new oc.BRep_Builder());
    const map = fixtures.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(entry.shape, map, true, true);
    for (let index = 1; index <= map.Size(); index += 1) {
      const shape = fixtures.keep(map.FindKey(index));
      if (shape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) builder.UpdateEdge_19(fixtures.keep(oc.TopoDS.Edge_1(shape)), 1e-4);
    }
    const box = fixtures.keep(conservativeBodyBounds(oc, entry.shape));
    expect(box.GetGap()).toBeGreaterThanOrEqual(1.01e-4 - 1e-12);
    const world = conservativeWorldBounds(oc, box, identity); if (world === null) throw new Error('finite'); fixtures.keep(world);
    const range = placementModule.boundingBoxRange(world);
    expect(range.min[0]).toBeLessThanOrEqual(-1e-4); expect(range.max[0]).toBeGreaterThanOrEqual(20 + 1e-4);
  });
  it('K06 固定5姿勢で公差込み8隅を必ず世界箱内に包む', () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    const box = fixtures.keep(conservativeBodyBounds(oc, entry.shape)); box.SetGap(1e-4);
    const local = placementModule.boundingBoxRange(box);
    for (const rotation of [[0, 0, 0, 1], [0, 0, 0.3, 0.9], [0.1, 0.4, 0.2, 0.8], [1, 0, 0, 0], [-0.4, 0.2, 0.8, 0.3]]) {
      const placement: PlacementSpec = { position: [123, -48, 22], rotation: [rotation[0], rotation[1], rotation[2], rotation[3]] };
      const world = conservativeWorldBounds(oc, box, placement); if (world === null) throw new Error('finite'); fixtures.keep(world);
      const transform = placementModule.makePlacementTransform(oc, placement, fixtures.keep);
      const range = placementModule.boundingBoxRange(world);
      for (const x of [local.min[0], local.max[0]]) for (const y of [local.min[1], local.max[1]]) for (const z of [local.min[2], local.max[2]]) {
        const point = fixtures.keep(new oc.gp_Pnt_3(x, y, z)); point.Transform(transform);
        for (const [axis, value] of [point.X(), point.Y(), point.Z()].entries()) {
          expect(value).toBeGreaterThanOrEqual(range.min[axis] - 1e-6); expect(value).toBeLessThanOrEqual(range.max[axis] + 1e-6);
        }
      }
    }
  });
  it('K07 同じlocal箱を再配置しても入力と各世界箱が独立する', () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    const local = fixtures.keep(conservativeBodyBounds(oc, entry.shape)); const before = placementModule.boundingBoxRange(local);
    const first = conservativeWorldBounds(oc, local, identity);
    const second = conservativeWorldBounds(oc, local, { ...identity, position: [50, 0, 0] });
    if (first === null || second === null) throw new Error('finite'); fixtures.keep(first); fixtures.keep(second);
    expect(placementModule.boundingBoxRange(local)).toEqual(before);
    const saved = placementModule.boundingBoxRange(first); second.SetGap(1);
    expect(placementModule.boundingBoxRange(first)).toEqual(saved);
    const repeated = conservativeWorldBounds(oc, local, identity); if (repeated === null) throw new Error('finite'); fixtures.keep(repeated);
    expect(placementModule.boundingBoxRange(repeated)).toEqual(saved);
  });
  it('K08 元Locationとassemblyの回転平行移動をそれぞれ一度適用する', async () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    const inner = fixtures.keep(placementModule.placeShape(oc, entry.shape, { position: [3, 4, 5], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }));
    bodies.set('located', { ...entry, shape: inner.shape });
    const outer: PlacementSpec = { position: [20, -10, 30], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] };
    const place = vi.spyOn(placementModule, 'placeShape');
    const result = await checkInterference(request([ready('a', ['located'], 0, outer), ready('b', ['located'], 0, outer)]), oc, bodies);
    volume(result, 8000); expect(place).toHaveBeenCalledTimes(2);
    const mesh = result.pairs[0].mesh.positions;
    expect(Math.min(...Array.from(mesh).filter((_, index) => index % 3 === 0))).toBeCloseTo(3, 5);
  });
  it('K09 whole/open箱は無条件候補となる', async () => {
    const original = oc.BRepBndLib.Add.bind(oc.BRepBndLib);
    for (const kind of ['whole', 'open']) {
      const hook = vi.spyOn(oc.BRepBndLib, 'Add').mockImplementation((shape, box, triangles) => {
        original(shape, box, triangles); if (kind === 'whole') box.SetWhole(); else box.OpenXmax();
      });
      const common = vi.spyOn(commonModule, 'intersectionVolume');
      volume(await checkInterference(request(), oc, bodies), 2000); expect(common).toHaveBeenCalledTimes(1);
      hook.mockRestore(); common.mockRestore();
    }
  });
  it('K10 重なる2bodyはunion後の1500であり2000へ二重計上しない', async () => {
    addBox('x', 10); addBox('y', 10, 5);
    volume(await checkInterference(request([ready('a', ['x', 'y']), ready('b', ['box'])]), oc, bodies), 1500);
  });
  it('K11 離れた2bodyを両方含めた2000を返す', async () => {
    addBox('x', 10); addBox('y', 10, 20); addBox('outer', 40);
    volume(await checkInterference(request([ready('a', ['x', 'y']), ready('b', ['outer'])]), oc, bodies), 2000);
  });
  it('K12 3bodyのunion chainで重複領域を一度だけ数える', async () => {
    addBox('x', 10); addBox('y', 10, 5); addBox('z', 10, 10);
    volume(await checkInterference(request([ready('a', ['x', 'y', 'z']), ready('b', ['box'])]), oc, bodies), 2000);
  });
  it('K13 重複bodyKeyはunionを増やさない', async () => {
    const union = vi.spyOn(booleanModule, 'booleanOp');
    volume(await checkInterference(request([ready('a', ['box', 'box']), ready('b', ['box'], 15)]), oc, bodies), 2000);
    expect(union).not.toHaveBeenCalled();
  });
  it('K14 同じbody集合は順序が違ってもunionを1回だけ共有する', async () => {
    addBox('x', 10); addBox('y', 10, 5);
    const union = vi.spyOn(booleanModule, 'booleanOp'); const place = vi.spyOn(placementModule, 'placeShape');
    volume(await checkInterference(request([ready('a', ['x', 'y']), ready('b', ['y', 'x'], 10)]), oc, bodies), 500);
    expect(union).toHaveBeenCalledTimes(1); expect(place).toHaveBeenCalledTimes(2);
  });
  it('K15 同じpartの2instanceも別componentとして比較する', async () => {
    volume(await checkInterference(request([ready('instance:1', ['box']), ready('instance:2', ['box'])]), oc, bodies), 8000);
  });
  it('K16 component内部のbody同士はpairを作らない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const box = vi.spyOn(oc.BRepBndLib, 'Add');
    const result = await checkInterference(request([ready('only', ['box', 'missing'])]), oc, bodies);
    expect(result).toMatchObject({ totalPairCount: 0, failures: [], pairs: [] }); expect(common).not.toHaveBeenCalled(); expect(box).not.toHaveBeenCalled();
  });
  it('K17 hiddenは関与pairだけをskipしてnativeへ渡さない', async () => {
    const box = vi.spyOn(oc.BRepBndLib, 'Add');
    const result = await checkInterference(request([{ kind: 'excluded', componentId: 'a', reason: 'hidden' }, ready('b', ['box']), ready('c', ['box'], 15)]), oc, bodies);
    expect(result.skippedPairCount).toBe(2); expect(result.pairs).toHaveLength(1); expect(box).toHaveBeenCalledTimes(1); accounting(result);
  });
  it('K18 suppressedはshapeや配置がなくてもfailureにしない', async () => {
    const result = await checkInterference(request([{ kind: 'excluded', componentId: 'a', reason: 'suppressed' }, ready('b', ['missing'])]), oc, bodies);
    expect(result).toMatchObject({ skippedPairCount: 1, failures: [], pendingPairCount: 0 }); accounting(result);
  });
  it('K19 除外のreverse/重複を正規化しsuppressed→hidden→ignoredを守る', async () => {
    const result = await checkInterference({ ...request([{ kind: 'excluded', componentId: 'a', reason: 'suppressed' },
      { kind: 'excluded', componentId: 'b', reason: 'hidden' }, ready('c', ['box']), ready('d', ['box'])]),
    ignoredPairs: [['b', 'a'], ['c', 'b'], ['d', 'c'], ['c', 'd']] }, oc, bodies);
    expect(result.skips.map((skip) => skip.reason)).toEqual(['suppressed', 'suppressed', 'suppressed', 'hidden', 'hidden', 'ignored']); accounting(result);
  });
  it('K20 固定同士にも除外の指定が無ければ体積を返す', async () => {
    const result = await checkInterference(request(), oc, bodies); volume(result, 2000); expect(result.skips).toEqual([]);
  });
  it('K21 Commonの1pair失敗をclearにせず後続pairを続行する', async () => {
    vi.spyOn(commonModule, 'intersectionVolume').mockImplementationOnce(() => ({ kind: 'failed', shape: null, volume: null,
      failure: { code: 'buildFailed', stage: 'build', message: 'injected build failure' } }));
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 5), ready('c', ['box'], 10)]), oc, bodies);
    expect(result.kind).toBe('checked'); expect(result.failures).toHaveLength(1); expect(result.pairs).toHaveLength(2); accounting(result);
  });
  it('K22 mesh失敗でもCommonを解放し後続を継続する', async () => {
    addBox('copy');
    vi.spyOn(meshModule, 'buildExportMesh').mockImplementationOnce(() => { throw new Error('mesh failed'); });
    const observer = observe();
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['copy'], 5), ready('c', ['box'], 10)]), oc, bodies);
    expect(result.failures[0].code).toBe('meshFailed'); expect(result.pairs).toHaveLength(2); observer.expectReleased(); accounting(result);
  });
  it('K23 task24のbelowThresholdは再比較せずmeshを作らず解放する', async () => {
    const tiny = fixtures.keep(makeBox(oc, { dx: 0.005, dy: 0.01, dz: 0.01 }));
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture'); bodies.set('tiny', { ...entry, shape: tiny.shape });
    const mesh = vi.spyOn(meshModule, 'buildExportMesh'); const observer = observe();
    const result = await checkInterference(request([ready('a', ['tiny']), ready('b', ['box'])]), oc, bodies);
    expect(result).toMatchObject({ checkedPairCount: 1, failures: [], pairs: [] }); expect(mesh).not.toHaveBeenCalled(); observer.expectReleased();
  });
  it('K24 成功/Common失敗/mesh失敗後も同じ入力を測定と加工へ再利用できる', async () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    addBox('copy');
    const interference = request([ready('a', ['box']), ready('b', ['copy'], 15)]);
    const before = metrics(entry.shape); const bytes = structuredClone(entry.mesh);
    for (const mode of ['success', 'common', 'mesh']) {
      if (mode === 'common') vi.spyOn(oc.BRepAlgoAPI_Common.prototype, 'Build').mockImplementationOnce(() => { throw new Error('build'); });
      if (mode === 'mesh') vi.spyOn(meshModule, 'buildExportMesh').mockImplementationOnce(() => { throw new Error('mesh'); });
      await checkInterference(interference, oc, bodies); vi.restoreAllMocks();
      expect(metrics(entry.shape)).toEqual(before); expect(entry.mesh).toEqual(bytes);
      const tool = fixtures.keep(placementModule.placeShape(oc, entry.shape, { ...identity, position: [15, 0, 0] }));
      const cut = booleanModule.booleanOp(oc, 'subtract', entry.shape, tool.shape);
      try { expect(Math.abs(cut.volume - 6000)).toBeLessThanOrEqual(1e-6); } finally { cut.delete(); }
    }
  });
  it('K25 missing/null bodyを関与pairだけのfailureとして保持する', async () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    const nullShape = fixtures.keep(new oc.TopoDS_Shape()); bodies.set('null', { ...entry, shape: nullShape });
    const result = await checkInterference(request([ready('a', ['missing']), ready('b', ['null']), ready('c', ['box']), ready('d', ['box'], 15)]), oc, bodies);
    expect(result.failures).toHaveLength(5); expect(result.failures.flatMap((failure) => failure.missingKeys ?? [])).toContain('missing');
    expect(result.pairs).toHaveLength(1); accounting(result);
  });
  it('K26 shell/meshが混ざった部品を一部だけ計算しない', async () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture'); const common = vi.spyOn(commonModule, 'intersectionVolume');
    for (const bodyKind of ['shell', 'mesh']) {
      if (bodyKind !== 'shell' && bodyKind !== 'mesh') throw new Error('kind');
      bodies.set('unsupported', { ...entry, mesh: { ...entry.mesh, bodyKind } });
      const result = await checkInterference(request([ready('a', ['box', 'unsupported']), ready('b', ['box'])]), oc, bodies);
      expect(result.failures[0].code).toBe('unsupportedBody'); expect(result.checkedPairCount).toBe(0);
    }
    expect(common).not.toHaveBeenCalled();
  });
  it('K27 NaN/Infinity/norm0の配置は対象のnative処理前に拒否する', async () => {
    for (const placement of [{ ...identity, position: [NaN, 0, 0] }, { ...identity, position: [Infinity, 0, 0] }, { ...identity, rotation: [0, 0, 0, 0] }]) {
      const invalid: PlacementSpec = { position: [placement.position[0], placement.position[1], placement.position[2]], rotation: [placement.rotation[0], placement.rotation[1], placement.rotation[2], placement.rotation[3]] };
      const place = vi.spyOn(placementModule, 'placeShape');
      const result = await checkInterference(request([ready('a', ['box'], 0, invalid), ready('b', ['box'])]), oc, bodies);
      expect(result.failures[0].code).toBe('invalidPlacement'); expect(place).not.toHaveBeenCalled(); place.mockRestore();
    }
  });
  it('K28 pair delete故障でも全解放を試し成功へ登録しない', async () => {
    const original = commonModule.intersectionVolume;
    vi.spyOn(commonModule, 'intersectionVolume').mockImplementationOnce((...args) => {
      const result = original(...args); if (result.kind !== 'overlap') throw new Error('overlap');
      return { ...result, delete() { result.delete(); throw new Error('delete failure after native release'); } };
    });
    const observer = observe(); const result = await checkInterference(request(), oc, bodies);
    expect(result.pairs).toEqual([]); expect(result.failures[0].code).toBe('cleanupFailed'); observer.expectReleased(); accounting(result);
  });
  it('K29 union途中故障はchainを逆解放し独立pairを続行する', async () => {
    addBox('x', 10); addBox('y', 10, 5); addBox('z', 10, 10);
    const original = booleanModule.booleanOp; let calls = 0;
    vi.spyOn(booleanModule, 'booleanOp').mockImplementation((...args) => { calls += 1; if (calls === 2) throw new Error('second union'); return original(...args); });
    const observer = observe();
    const result = await checkInterference(request([ready('a', ['x', 'y', 'z']), ready('b', ['box']), ready('c', ['box'], 5)]), oc, bodies);
    expect(result.failures).toHaveLength(2); expect(result.pairs).toHaveLength(1); observer.expectReleased(); accounting(result);
  });
  it('K30 箱生成/変換/角取得/解放の各故障で確保分を全解放し陰性を捏造しない', async () => {
    for (const point of ['add', 'transform', 'corner', 'release']) {
      const observer = observe();
      if (point === 'add') vi.spyOn(oc.BRepBndLib, 'Add').mockImplementationOnce(() => { throw new Error('add'); });
      if (point === 'transform') vi.spyOn(oc.Bnd_Box.prototype, 'Transformed').mockImplementationOnce(() => { throw new Error('transform'); });
      if (point === 'corner') vi.spyOn(oc.Bnd_Box.prototype, 'CornerMin').mockImplementationOnce(() => { throw new Error('corner'); });
      if (point === 'release') {
        const native = captureMethod(oc.Bnd_Box.prototype, 'delete');
        vi.spyOn(oc.Bnd_Box.prototype, 'delete').mockImplementationOnce(function (this: Bnd_Box) { native.call(this); throw new Error('release after native delete'); });
      }
      const result = await checkInterference(request(), oc, bodies);
      expect(result.checkedPairCount).toBe(0); expect(result.pairs).toEqual([]); expect(result.failures.length + (result.kind === 'failed' ? 1 : 0)).toBeGreaterThan(0);
      observer.expectReleased(); accounting(result); vi.restoreAllMocks();
    }
  });
  it('K31 50回反復で観測wrapper確保=解放となり入力所有を奪わない', async () => {
    const entry = bodies.get('box'); if (entry === undefined) throw new Error('fixture');
    const inputDelete = vi.spyOn(entry.shape, 'delete'); const observer = observe();
    for (let index = 0; index < 50; index += 1) volume(await checkInterference(request(), oc, bodies), 2000);
    observer.expectReleased(); expect(inputDelete).not.toHaveBeenCalled();
  });
  it('K32 開始前取消はnativeを作らずpendingを保つ', async () => {
    const box = vi.spyOn(oc.BRepBndLib, 'Add');
    const result = await checkInterference(request(), oc, bodies, undefined, () => true);
    expect(result).toMatchObject({ cancelled: true, pendingPairCount: 1, checkedPairCount: 0 }); expect(box).not.toHaveBeenCalled(); accounting(result);
  });
  it('K33 pair境界取消は確定済みの結果を保ち後続Commonを始めない', async () => {
    let cancel = false; const common = vi.spyOn(commonModule, 'intersectionVolume');
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 5), ready('c', ['box'], 10)]), oc, bodies,
      (progress) => { if (progress.completedPairs === 1) cancel = true; }, () => cancel);
    expect(common).toHaveBeenCalledTimes(1); expect(result.pairs).toHaveLength(1); expect(result.pendingPairCount).toBe(2); expect(result.cancelled).toBe(true); accounting(result);
  });
  it('K34 union途中取消は次のunion/Commonを始めずchainを返す', async () => {
    addBox('x', 10); addBox('y', 10, 5); addBox('z', 10, 10);
    let cancel = false; const original = booleanModule.booleanOp;
    const union = vi.spyOn(booleanModule, 'booleanOp').mockImplementation((...args) => { const result = original(...args); cancel = true; return result; });
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const observer = observe();
    const result = await checkInterference(request([ready('a', ['x', 'y', 'z']), ready('b', ['box'])]), oc, bodies, undefined, () => cancel);
    expect(union).toHaveBeenCalledTimes(1); expect(common).not.toHaveBeenCalled(); expect(result.cancelled).toBe(true); observer.expectReleased(); accounting(result);
  });
  it('K35 frozen入力を非変更で読み選択pair順を文書順へ正規化する', async () => {
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 5), ready('c', ['box'], 10)]), pairs: [['c', 'b'], ['b', 'a'], ['a', 'b']] };
    const before = JSON.stringify(input);
    for (const component of input.components) { if (component.kind === 'ready') { Object.freeze(component.bodyKeys); Object.freeze(component.placement); } Object.freeze(component); }
    Object.freeze(input.components); Object.freeze(input);
    const result = await checkInterference(input, oc, bodies);
    expect(result.totalPairCount).toBe(2); expect(result.pairs.map((pair) => [pair.aComponentId, pair.bComponentId])).toEqual([['a', 'b'], ['b', 'c']]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('K36 固定入力5回でvolume/mesh bytes/順序/件数が一致する', async () => {
    const input = request([ready('a', ['box']), ready('b', ['box'], 5), ready('c', ['box'], 10), ready('d', ['missing'])]);
    const first = await checkInterference(input, oc, bodies);
    for (let index = 1; index < 5; index += 1) expect(await checkInterference(input, oc, bodies)).toEqual(first);
  });
  it('K37 callback失敗とCommon解放失敗を併記し全所有物の解放を試す', async () => {
    const original = commonModule.intersectionVolume;
    vi.spyOn(commonModule, 'intersectionVolume').mockImplementationOnce((...args) => {
      const common = original(...args); if (common.kind !== 'overlap') throw new Error('overlap');
      return { ...common, delete() { common.delete(); throw new Error('common cleanup'); } };
    });
    const observer = observe();
    const result = await checkInterference(request(), oc, bodies, (progress) => {
      if (progress.phase === 'mesh') throw new Error('progress unavailable');
    });
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'callbackFailed', message: 'progress unavailable', cleanupMessages: ['common cleanup'] }, pendingPairCount: 1 });
    observer.expectReleased(); accounting(result);
  });
  it('K38 予期しないCommon例外もそのpairへ記録し後続pairを完了する', async () => {
    vi.spyOn(commonModule, 'intersectionVolume').mockImplementationOnce(() => { throw new Error('unexpected common'); });
    const observer = observe();
    const result = await checkInterference(request([ready('a', ['box']), ready('b', ['box'], 5), ready('c', ['box'], 10)]), oc, bodies);
    expect(result.kind).toBe('checked'); expect(result.failures).toMatchObject([{ pair: ['a', 'b'], code: 'occtException' }]);
    expect(result.checkedPairCount).toBe(2); expect(result.pendingPairCount).toBe(0); observer.expectReleased(); accounting(result);
  });
  it('K39 複数bodyのbounds準備の間に取消を配送し次のbodyを始めない', async () => {
    addBox('second', 10, 5);
    let cancel = false; const native = oc.BRepBndLib.Add.bind(oc.BRepBndLib);
    const bounds = vi.spyOn(oc.BRepBndLib, 'Add').mockImplementation((...args) => { native(...args); cancel = true; });
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const observer = observe();
    const result = await checkInterference(request([ready('a', ['box', 'second']), ready('b', ['box'])]), oc, bodies, undefined, () => cancel);
    expect(bounds).toHaveBeenCalledTimes(1); expect(common).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cancelled: true, pendingPairCount: 1 }); observer.expectReleased(); accounting(result);
  });
  it('K40 厳密に同じ相対配置はCommon/直接meshを共有し独立world meshを返す', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const mesh = vi.spyOn(meshModule, 'buildExportMesh');
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 5), ready('c', ['box'], 10), ready('d', ['box'], 15)]), pairs: [['a', 'b'], ['b', 'c'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies);
    expect(common).toHaveBeenCalledTimes(1); expect(mesh).not.toHaveBeenCalled(); expect(result.pairs).toHaveLength(3);
    for (const [index, pair] of result.pairs.entries()) {
      expect(pair.volume).toBeCloseTo(6000, 6);
      const x = pair.mesh.positions.filter((_, axis) => axis % 3 === 0);
      expect(Math.min(...x)).toBe((index + 1) * 5); expect(Math.max(...x)).toBe(20 + index * 5);
    }
    expect(result.pairs[0].mesh.positions).not.toBe(result.pairs[1].mesh.positions);
    expect(result.pairs[0].mesh.normals).not.toBe(result.pairs[1].mesh.normals); accounting(result);
  });
  it('K41 doubleの差が同じでも減算誤差が違う相対配置を混同しない', async () => {
    expect(0.04 - 0.01).toBe(0.03);
    addWedge();
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['wedge']), ready('b', ['wedge'], 0.03), ready('c', ['wedge'], 0.01), ready('d', ['wedge'], 0.04)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies);
    expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(2); accounting(result);
  });
  it('K42 相対平行移動が同じでも回転が異なるpairは共有しない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const half = Math.sqrt(0.5);
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box']), ready('c', ['box'], 0, { position: [100, 0, 0], rotation: [0, 0, half, half] }), ready('d', ['box'], 100)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies);
    expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(1); accounting(result);
  });
  it('K43 大きなworld座標で量子化されたmeshを原点側へ持ち回さない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['box'], 100_000_000), ready('b', ['box'], 100_000_015), ready('c', ['box']), ready('d', ['box'], 15)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies);
    expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(2);
    const origin = result.pairs.find((pair) => pair.aComponentId === 'c'); expect(origin).toBeDefined();
    expect(origin?.mesh.positions.some((value) => value === 15)).toBe(true); accounting(result);
  });
  it('K44 同じ相対配置でも面接触/clearは共有せず実Commonへ戻す', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume'); const mesh = vi.spyOn(meshModule, 'buildExportMesh');
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 20), ready('c', ['box'], 100), ready('d', ['box'], 120)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies);
    expect(common).toHaveBeenCalledTimes(2); expect(mesh).not.toHaveBeenCalled(); expect(result.checkedPairCount).toBe(2); expect(result.pairs).toEqual([]); accounting(result);
  });
  it('K45 job後に結果meshを書き換えても次jobの結果へ漏れない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const first = await checkInterference(request(), oc, bodies); first.pairs[0].mesh.positions.fill(999);
    const second = await checkInterference(request(), oc, bodies);
    expect(common).toHaveBeenCalledTimes(2); expect(second.pairs[0].mesh.positions).not.toContain(999); volume(second, 2000);
  });
  it('K46 任意寸法の実直方体を認証し表面積を上から囲む', () => {
    for (const [dx, dy, dz] of [[20, 20, 20], [13, 7, 3], [1, 0.01, 0.01]]) {
      const shape = fixtures.keep(makeBox(oc, { dx, dy, dz }));
      const proof = certifyInterferenceBox(oc, shape.shape); expect(proof).not.toBeNull();
      const area = 2 * (dx * dy + dy * dz + dz * dx);
      expect(proof?.surfaceAreaUpper).toBeGreaterThanOrEqual(area); expect(proof?.surfaceAreaUpper).toBeLessThan(area * (1 + 1e-12));
    }
  });
  it('K47 8頂点12辺6平面のwedgeを直方体と誤認しない', () => {
    const wedge = addWedge(); expect(wedge.mesh.vertices).toHaveLength(8); expect(wedge.mesh.edges).toHaveLength(12); expect(wedge.mesh.faces).toHaveLength(6);
    expect(certifyInterferenceBox(oc, wedge.shape)).toBeNull();
  });
  it('K48 認証箱の誤差境界内だけ近接相対配置を共有し体積誤差を守る', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 0.03), ready('c', ['box'], 0.01), ready('d', ['box'], 0.04)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies);
    expect(common).toHaveBeenCalledTimes(1); expect(result.pairs).toHaveLength(2);
    for (const pair of result.pairs) expect(Math.abs(pair.volume - 400 * (20 - 0.03))).toBeLessThan(1e-6);
    const delta = interferenceTranslationDeltaUpper([0.03, 0, 0, 0, 0, 0], [0.03, 1.734723475976807e-18, 0, 0, 0, 0]);
    expect(delta).toBeGreaterThanOrEqual(1.734723475976807e-18); expect(delta).toBeLessThan(1e-7); expect(2400 * delta).toBeLessThan(1e-6); accounting(result);
  });
  it('K49 点変位が1e-7mm以上の相対差は通常Commonへ戻す', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 15), ready('c', ['box'], 0.01), ready('d', ['box'], 15.0100002)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies); expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(2); accounting(result);
  });
  it('K50 点変位内でもSδ体積上界が1e-6mm³以上なら共有しない', async () => {
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 15), ready('c', ['box'], 0.01), ready('d', ['box'], 15.010000002)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies); expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(2); accounting(result);
  });
  it('K51 体積閾値を跨ぎ得る近接pairはoverlapとclearを別々に判定する', async () => {
    const handle = fixtures.keep(makeBox(oc, { dx: 1, dy: 0.01, dz: 0.01 }));
    bodies.set('small', { shape: handle.shape, mesh: buildSolidBodyMesh(oc, 'small', handle.shape), delete: () => undefined });
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['small']), ready('b', ['small'], 0.99 - 1e-10), ready('c', ['small'], 2), ready('d', ['small'], 2.99 + 1e-10)]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies); expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(1); expect(result.checkedPairCount).toBe(2); accounting(result);
  });
  it('K52 箱同士でも面軸が平行でない近接配置は近似共有しない', async () => {
    const half = 0.1; const rotation: PlacementSpec['rotation'] = [0, 0, Math.sin(half), Math.cos(half)];
    const common = vi.spyOn(commonModule, 'intersectionVolume');
    const input: InterferenceRequest = { ...request([ready('a', ['box']), ready('b', ['box'], 0, { position: [0.03, 0, 0], rotation }), ready('c', ['box'], 0.01), ready('d', ['box'], 0, { position: [0.04, 0, 0], rotation })]), pairs: [['a', 'b'], ['c', 'd']] };
    const result = await checkInterference(input, oc, bodies); expect(common).toHaveBeenCalledTimes(2); expect(result.pairs).toHaveLength(2); accounting(result);
  });
  it('K53 directの再利用task queueもCommon後のtimer取消をmesh前に届ける', async () => {
    let cancel = false; const native = commonModule.intersectionVolume;
    vi.spyOn(commonModule, 'intersectionVolume').mockImplementation((...args) => { const result = native(...args); setTimeout(() => { cancel = true; }, 0); return result; });
    const mesh = vi.spyOn(meshModule, 'buildExportMesh');
    for (let run = 0; run < 10; run += 1) {
      cancel = false;
      const result = await checkInterference(request(), oc, bodies, undefined, () => cancel);
      expect(result).toMatchObject({ cancelled: true, checkedPairCount: 0, pendingPairCount: 1 }); expect(mesh).not.toHaveBeenCalled(); accounting(result);
    }
  });
  it('K54 queueのport/listenerは成功/取消/callback例外の全てで閉じる', async () => {
    const Channel = MessageChannel; const checks: Array<() => void> = [];
    vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel(); const first = vi.spyOn(channel.port1, 'close'); const second = vi.spyOn(channel.port2, 'close');
      checks.push(() => { expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1); expect(channel.port1.onmessage).toBeNull(); });
      return channel;
    });
    for (const mode of ['success', 'cancel', 'throw']) {
      const result = await checkInterference(request(), oc, bodies, () => { if (mode === 'throw') throw new Error('callback'); }, () => mode === 'cancel');
      accounting(result);
    }
    expect(checks).toHaveLength(3); for (const check of checks) check();
  });
  it('K55 queueのcloseが投げてももう片方と全nativeを解放する', async () => {
    const Channel = MessageChannel; let secondClosed = false;
    vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel(); const first = channel.port1.close.bind(channel.port1); const second = channel.port2.close.bind(channel.port2);
      channel.port1.close = () => { first(); throw new Error('queue close'); };
      channel.port2.close = () => { second(); secondClosed = true; }; return channel;
    });
    const observer = observe(); const result = await checkInterference(request(), oc, bodies, undefined, () => false);
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'cleanupFailed', cleanupMessages: ['queue close'] }, checkedPairCount: 1 });
    expect(secondClosed).toBe(true); observer.expectReleased(); accounting(result);
  });
  it('K56 開始前取消とclose故障が同時でも最終cleanupFailedとpendingを返す', async () => {
    const Channel = MessageChannel; const checks: Array<() => void> = [];
    vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel(); const close = channel.port1.close.bind(channel.port1);
      const first = vi.spyOn(channel.port1, 'close').mockImplementation(() => { close(); throw new Error('cancel close'); });
      const second = vi.spyOn(channel.port2, 'close');
      checks.push(() => {
        expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
        expect(channel.port1.onmessage).toBeNull(); expect(channel.port2.onmessage).toBeNull();
      });
      return channel;
    });
    const observer = observe(); const common = vi.spyOn(commonModule, 'intersectionVolume');
    const result = await checkInterference(request(), oc, bodies, undefined, () => true);
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'cleanupFailed', cleanupMessages: ['cancel close'] },
      cancelled: true, checkedPairCount: 0, pendingPairCount: 1 });
    expect(observer.entries).toHaveLength(0); expect(common).not.toHaveBeenCalled();
    expect(checks).toHaveLength(1); checks.forEach((check) => { check(); }); accounting(result);
  });
  it('K57 非同期relayのpostMessage故障を未捕捉にせずjobを決着して両portを閉じる', async () => {
    const Channel = MessageChannel; const checks: Array<() => void> = []; const teardown: Array<() => void> = [];
    vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel(); const closeFirst = channel.port1.close.bind(channel.port1); const closeSecond = channel.port2.close.bind(channel.port2);
      const first = vi.spyOn(channel.port1, 'close'); const second = vi.spyOn(channel.port2, 'close');
      // port2への初回投稿は実配送し、受信callback内の次の投稿だけを故障させる。
      vi.spyOn(channel.port1, 'postMessage').mockImplementation(() => { throw new Error('async relay'); });
      checks.push(() => {
        expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
        expect(channel.port1.onmessage).toBeNull(); expect(channel.port2.onmessage).toBeNull();
      });
      teardown.push(() => { channel.port1.onmessage = null; channel.port2.onmessage = null; closeFirst(); closeSecond(); });
      return channel;
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([checkInterference(request(), oc, bodies, undefined, () => false),
        new Promise<'unsettled'>((resolve) => { timeout = setTimeout(() => { resolve('unsettled'); }, 2000); })]);
      expect(result).toMatchObject({ kind: 'failed', failure: { code: 'unexpectedFailure', message: 'async relay' },
        cancelled: false, checkedPairCount: 0, pendingPairCount: 1 });
      if (result === 'unsettled') throw new Error('job must settle');
      expect(checks).toHaveLength(1); checks.forEach((check) => { check(); }); accounting(result);
    } finally { clearTimeout(timeout); teardown.forEach((close) => { close(); }); }
  });
  it('K58 Common保有中のrelay故障とCommon/port解放故障を併記し全解放する', async () => {
    let commonStarted = false; const native = commonModule.intersectionVolume;
    vi.spyOn(commonModule, 'intersectionVolume').mockImplementationOnce((...args) => {
      const common = native(...args); if (common.kind !== 'overlap') throw new Error('overlap');
      commonStarted = true;
      return { ...common, delete() { common.delete(); throw new Error('common cleanup'); } };
    });
    const Channel = MessageChannel; const checks: Array<() => void> = [];
    vi.spyOn(globalThis, 'MessageChannel').mockImplementation(function () {
      const channel = new Channel(); const post = channel.port1.postMessage.bind(channel.port1);
      const close = channel.port2.close.bind(channel.port2);
      vi.spyOn(channel.port1, 'postMessage').mockImplementation((...args) => {
        if (commonStarted) throw new Error('common relay'); post(...args);
      });
      const first = vi.spyOn(channel.port1, 'close');
      const second = vi.spyOn(channel.port2, 'close').mockImplementation(() => { close(); throw new Error('port cleanup'); });
      checks.push(() => {
        expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
        expect(channel.port1.onmessage).toBeNull(); expect(channel.port2.onmessage).toBeNull();
      });
      return channel;
    });
    const observer = observe(); const mesh = vi.spyOn(meshModule, 'buildExportMesh');
    const result = await checkInterference(request(), oc, bodies, undefined, () => false);
    expect(result).toMatchObject({ kind: 'failed', failure: { code: 'unexpectedFailure', message: 'common relay',
      cleanupMessages: ['common cleanup', 'port cleanup'] }, cancelled: false, checkedPairCount: 0, pendingPairCount: 1 });
    expect(mesh).not.toHaveBeenCalled(); observer.expectReleased(); accounting(result);
    expect(checks).toHaveLength(1); checks.forEach((check) => { check(); });
  });
});
