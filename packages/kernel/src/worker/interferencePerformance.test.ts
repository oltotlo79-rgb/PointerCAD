import { expectWithinBudget } from '@pointercad/test-utils';
import * as Comlink from 'comlink';
import type { BRepAlgoAPI_BuilderAlgo, OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as allocationsModule from '../occt/allocations.js';
import type { OcctDeletable } from '../occt/allocations.js';
import * as booleanModule from '../occt/booleanOp.js';
import * as commonModule from '../occt/intersectionVolume.js';
import * as meshModule from '../occt/exportMesh.js';
import * as placementModule from '../occt/placeBodies.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeBox } from '../occt/makeBox.js';
import { buildSolidBodyMesh } from '../occt/solidMesh.js';
import type { InterferenceComponentSpec, InterferenceRequest, InterferenceResult } from '../types.js';
import { createKernelApi } from './kernelApi.js';
import * as interferenceModule from './checkInterference.js';
import type { CachedSolid } from './recomputeSolids.js';
import { createShapeCache } from './shapeCache.js';

let oc: OpenCascadeInstance;
beforeAll(async () => {
  const start = performance.now(); oc = await loadOcctForNode();
  console.log(`P7-25 WASM初期化（総時間の外）: ${performance.now() - start}ms`);
}, 180_000);

/** 実native methodを控え、計測callbackのthisをそのまま渡す。 */
function captureMethod<Key extends string, Args extends unknown[], Result>(
  prototype: Record<Key, (...args: Args) => Result>, key: Key,
): (this: Record<Key, (...args: Args) => Result>, ...args: Args) => Result {
  const method = prototype[key];
  return function (this: Record<Key, (...args: Args) => Result>, ...args: Args): Result {
    return method.apply(this, args);
  };
}

/** 実物の処理を包む計器。数値を差し替えず、計器の費用も全経路時間へ含める。 */
function instrument() {
  let calls: Record<string, number> = {}; let milliseconds: Record<string, number> = {};
  let live = 0; let peak = 0; let allocated = 0; let released = 0;
  let candidates = 0;
  const seen = new WeakSet<OcctDeletable>();
  function timed<T>(stage: string, action: () => T): T {
    const start = performance.now(); calls[stage] = (calls[stage] ?? 0) + 1;
    try { return action(); } finally { milliseconds[stage] = (milliseconds[stage] ?? 0) + performance.now() - start; }
  }
  function track<T extends OcctDeletable>(item: T): T {
    if (seen.has(item)) return item; seen.add(item); allocated += 1; live += 1; peak = Math.max(peak, live);
    const nativeDelete = item.delete.bind(item);
    item.delete = () => { timed('release', nativeDelete); released += 1; live -= 1; };
    return item;
  }
  const create = allocationsModule.createAllocations;
  vi.spyOn(allocationsModule, 'createAllocations').mockImplementation(() => {
    const scope = create(); return { keep<T extends OcctDeletable>(item: T): T { return scope.keep(track(item)); }, release: scope.release };
  });
  const Box = oc.Bnd_Box_1;
  vi.spyOn(oc, 'Bnd_Box_1').mockImplementation(function () { return track(new Box()); });
  const bounds = oc.BRepBndLib.Add.bind(oc.BRepBndLib);
  vi.spyOn(oc.BRepBndLib, 'Add').mockImplementation((...args) => timed('localBounds', () => bounds(...args)));
  const transform = placementModule.transformedBoundingBox;
  vi.spyOn(placementModule, 'transformedBoundingBox').mockImplementation((...args) => timed('worldBounds', () => transform(...args)));
  const compare = placementModule.boundingBoxesOverlap;
  vi.spyOn(placementModule, 'boundingBoxesOverlap').mockImplementation((...args) => timed('aabbComparisons', () => {
    const overlaps = compare(...args); if (overlaps) candidates += 1; return overlaps;
  }));
  const union = booleanModule.booleanOp;
  vi.spyOn(booleanModule, 'booleanOp').mockImplementation((...args) => timed('union', () => union(...args)));
  const place = placementModule.placeShape;
  vi.spyOn(placementModule, 'placeShape').mockImplementation((...args) => timed('placement', () => place(...args)));
  const common = commonModule.intersectionVolume;
  vi.spyOn(commonModule, 'intersectionVolume').mockImplementation((...args) => timed('common', () => common(...args)));
  const setGlue = captureMethod<'SetGlue', Parameters<BRepAlgoAPI_BuilderAlgo['SetGlue']>, void>(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetGlue');
  vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetGlue').mockImplementation(function (this: BRepAlgoAPI_BuilderAlgo, mode) {
    expect(mode).toBe(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    timed('glue', () => { setGlue.call(this, mode); });
  });
  const setHistory = captureMethod<'SetToFillHistory', [boolean], void>(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetToFillHistory');
  vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetToFillHistory').mockImplementation(function (this: BRepAlgoAPI_BuilderAlgo, enabled) {
    expect(enabled).toBe(false);
    timed('historyDisabled', () => { setHistory.call(this, enabled); });
  });
  const setInverted = captureMethod<'SetCheckInverted', [boolean], void>(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetCheckInverted');
  vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, 'SetCheckInverted').mockImplementation(function (this: BRepAlgoAPI_BuilderAlgo, enabled) {
    expect(enabled).toBe(false);
    timed('certifiedNonInverted', () => { setInverted.call(this, enabled); });
  });
  const mesh = meshModule.buildExportMesh;
  vi.spyOn(meshModule, 'buildExportMesh').mockImplementation((...args) => timed('copyMesh', () => mesh(...args)));
  const snapshot = interferenceModule.snapshotInterferenceRequest;
  vi.spyOn(interferenceModule, 'snapshotInterferenceRequest').mockImplementation((...args) => timed('snapshot', () => snapshot(...args)));
  const prepare = interferenceModule.prepareInterference;
  vi.spyOn(interferenceModule, 'prepareInterference').mockImplementation((...args) => timed('pairPreparation', () => prepare(...args)));
  return {
    timed,
    reset() { expect(live).toBe(0); calls = {}; milliseconds = {}; allocated = 0; released = 0; peak = 0; candidates = 0; },
    read() { return { calls: { ...calls }, milliseconds: { ...milliseconds }, allocated, released, live, peak, candidates }; },
  };
}

function ready(index: number, x: number, keys: readonly string[]): InterferenceComponentSpec {
  return { kind: 'ready', componentId: `component-${index}`, bodyKeys: keys, placement: { position: [x, 0, 0], rotation: [0, 0, 0, 1] } };
}
function clusters(separation: number, keys: readonly string[]): InterferenceComponentSpec[] {
  return Array.from({ length: 50 }, (_, index) => ready(index,
    index < 20 ? Math.floor(index / 2) * 100 + (index % 2) * separation : index * 100, keys));
}
function assertResult(result: InterferenceResult, total: number, expectedVolumes: readonly number[]): void {
  expect(result.kind).toBe('checked'); expect(result.cancelled).toBe(false); expect(result.failures).toEqual([]);
  expect(result.totalPairCount).toBe(total); expect(result.checkedPairCount).toBe(total); expect(result.skippedPairCount).toBe(0); expect(result.pendingPairCount).toBe(0);
  expect(result.pairs.length).toBe(expectedVolumes.length);
  for (const [index, pair] of result.pairs.entries()) {
    expect(Math.abs(pair.volume - expectedVolumes[index])).toBeLessThanOrEqual(1e-6);
    expect(pair.mesh.triangleCount).toBeGreaterThan(0);
  }
}

async function measureFixture(id: string, kind: 'box' | 'sphere' | 'multi', components: readonly InterferenceComponentSpec[], volumes: readonly number[], expectedCommon: number): Promise<void> {
  const cache = createShapeCache<CachedSolid>();
  const fixtureStart = performance.now();
  function add(key: string, size: number, x: number, sphere = false): void {
    const scope = allocationsModule.createAllocations();
    try {
      const shape = sphere
        ? scope.keep(scope.keep(new oc.BRepPrimAPI_MakeSphere_1(10)).Shape())
        : scope.keep(placementModule.placeShape(oc, scope.keep(makeBox(oc, { dx: size, dy: size, dz: size })).shape,
          { position: [x, 0, 0], rotation: [0, 0, 0, 1] })).shape;
      cache.set(key, { shape, mesh: buildSolidBodyMesh(oc, key, shape), delete: scope.release });
    } catch (error) { scope.release(); throw error; }
  }
  if (kind === 'multi') { add('first', 10, 0); add('second', 10, 5); }
  else add('shape', 20, 0, kind === 'sphere');
  const fixtureMs = performance.now() - fixtureStart;
  const api = createKernelApi(() => Promise.resolve(oc), cache);
  const channel = new MessageChannel(); Comlink.expose(api, channel.port1);
  const remote = Comlink.wrap<ReturnType<typeof createKernelApi>>(channel.port2);
  const request: InterferenceRequest = { requestId: id, components };
  const total = components.length * (components.length - 1) / 2;
  const budget = components.length === 2 ? 500 : 2000;
  const records: unknown[] = []; const samples: number[] = [];
  const observed = instrument();
  const acquire = cache.acquire.bind(cache); const release = cache.release.bind(cache);
  vi.spyOn(cache, 'acquire').mockImplementation((...args) => observed.timed('leaseAcquire', () => acquire(...args)));
  vi.spyOn(cache, 'release').mockImplementation((...args) => observed.timed('leaseRelease', () => release(...args)));
  const calculate = api.checkInterference.bind(api); let apiMs = 0;
  vi.spyOn(api, 'checkInterference').mockImplementation(async (...args) => {
    const start = performance.now();
    try { return await calculate(...args); } finally { apiMs = performance.now() - start; }
  });
  try {
    // 同じ固定fixtureをwarmup1回、測定5回。準備/bounds/union/meshの事前生成はしない。
    for (let run = 0; run < 6; run += 1) {
      observed.reset(); const before = cache.stats();
      let progressCount = 0;
      const progress = Comlink.proxy(() => { progressCount += 1; });
      const cancel = Comlink.proxy(() => false);
      // callback portも試行ごとに確実に閉じるため、既存ComlinkのtransferHandlerで輸送する。
      const ports: MessagePort[] = [];
      const handler = Comlink.transferHandlers.get('proxy'); if (handler === undefined) throw new Error('proxy handler');
      Comlink.transferHandlers.set('proxy', {
        canHandle: handler.canHandle.bind(handler),
        serialize(value) {
          const callback = new MessageChannel();
          ports.push(callback.port1, callback.port2);
          Comlink.expose(value, callback.port1);
          return [callback.port2, [callback.port2]];
        },
        deserialize: handler.deserialize.bind(handler),
      });
      let result: InterferenceResult;
      let elapsed: number;
      const started = performance.now();
      try {
        result = await remote.checkInterference(request, progress, cancel, 'message');
      } finally {
        Comlink.transferHandlers.set('proxy', handler);
        for (const port of ports) port.close();
        elapsed = performance.now() - started;
      }
      const native = observed.read(); const after = cache.stats();
      assertResult(result, total, volumes);
      expect(native.candidates).toBe(volumes.length);
      expect(native.calls.common ?? 0).toBe(expectedCommon); expect(native.calls.union ?? 0).toBe(kind === 'multi' ? 1 : 0);
      expect(native.calls.copyMesh ?? 0).toBe(kind === 'box' ? 0 : expectedCommon);
      // Commonを省略せず証明済み部分一致だけを高速化。glue削除の退行は通常ゲートでも赤。
      expect(native.calls.glue ?? 0).toBe(kind === 'box' ? expectedCommon : 0);
      expect(native.calls.historyDisabled ?? 0).toBe(kind === 'box' ? expectedCommon : 0);
      expect(native.calls.certifiedNonInverted ?? 0).toBe(kind === 'box' ? expectedCommon : 0);
      expect(native.live).toBe(0); expect(native.allocated).toBe(native.released); expect(after.protectedKeyCount).toBe(before.protectedKeyCount);
      expect(progressCount).toBeGreaterThan(0);
      const bytes = result.pairs.reduce((sum, pair) => sum + pair.mesh.positions.byteLength + pair.mesh.normals.byteLength + pair.mesh.indices.byteLength, 0);
      const record = { run: run === 0 ? 'warmup' : run, elapsed, apiMs, transportAndCallbackTeardownMs: elapsed - apiMs,
        candidateCount: native.candidates, native, bytes, progressCount,
        protectedStart: before.protectedKeyCount, protectedEnd: after.protectedKeyCount };
      records.push(record); console.log(JSON.stringify({ id, ...record }));
      if (run > 0) samples.push(elapsed);
    }
    console.log(JSON.stringify({ id, fixtureMs, budget, samples, maximum: Math.max(...samples), records }));
    expectWithinBudget(Math.max(...samples), budget, id);
  } finally {
    vi.restoreAllMocks(); remote[Comlink.releaseProxy](); channel.port1.close(); channel.port2.close(); cache.clear();
  }
}

describe('P7-25 全経路の固定性能条件', () => {
  it('P01 20³箱2個5mm侵入はV2000、全経路500ms', async () => {
    await measureFixture('P01', 'box', [ready(0, 0, ['shape']), ready(1, 15, ['shape'])], [2000], 1);
  });
  it('P02 R10球2個距離10はV1308.9969389957471、全経路500ms', async () => {
    await measureFixture('P02', 'sphere', [ready(0, 0, ['shape']), ready(1, 10, ['shape'])], [1308.9969389957471], 1);
  });
  it('P03 離れた50箱は1225checked/Common0、全経路2秒', async () => {
    await measureFixture('P03', 'box', Array.from({ length: 50 }, (_, index) => ready(index, index * 100, ['shape'])), [], 0);
  });
  it('P04 10組の侵入と30孤立箱は候補10/共有Common1/各V2000、全経路2秒', async () => {
    await measureFixture('P04', 'box', clusters(15, ['shape']), Array.from({ length: 10 }, () => 2000), 1);
  });
  it('P05 密な50箱x=0.01iは全1225候補を返す、全経路2秒', async () => {
    const volumes: number[] = [];
    for (let a = 0; a < 50; a += 1) for (let b = a + 1; b < 50; b += 1) volumes.push(400 * (20 - 0.01 * (b - a)));
    await measureFixture('P05', 'box', Array.from({ length: 50 }, (_, index) => ready(index, index * 0.01, ['shape'])), volumes.sort((a, b) => b - a), 49);
    // 完走して全5回を報告するための検査タイムアウト。合格予算2000msは変更しない。
  }, 600_000);
  it('P06 複数body部品50配置はunion1/候補10/共有Common1/各V500、全経路2秒', async () => {
    await measureFixture('P06', 'multi', clusters(10, ['first', 'second']), Array.from({ length: 10 }, () => 500), 1);
  });
});
