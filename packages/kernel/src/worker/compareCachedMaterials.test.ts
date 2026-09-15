import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeBox } from '../occt/makeBox.js';
import { buildSolidBodyMesh, measureVolume } from '../occt/solidMesh.js';
import { createShapeCache, type AcquiringShapeCache } from './shapeCache.js';
import type { CachedSolid } from './recomputeSolids.js';
import { createKernelApi } from './kernelApi.js';
import { compareCachedMaterials } from './compareCachedMaterials.js';

let oc: OpenCascadeInstance;
const caches: AcquiringShapeCache<CachedSolid>[] = [];
beforeAll(async () => { oc = await loadOcctForNode(); });
afterEach(() => { for (const cache of caches.splice(0)) cache.clear(); });
function cache() { const value = createShapeCache<CachedSolid>(8); caches.push(value); return value; }
function box(target: AcquiringShapeCache<CachedSolid>, key: string, size: number) {
  const handle = makeBox(oc, { dx: size, dy: size, dz: size });
  const deleted = vi.fn(() => { handle.delete(); });
  const body: CachedSolid = { shape: handle.shape, mesh: buildSolidBodyMesh(oc, key, handle.shape), delete: deleted };
  target.set(key, body); return { body, deleted };
}
function latch() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, open() { if (resolve === undefined) throw new Error('準備がありません'); resolve(); } };
}

describe('形の比較は計算中の両入力を借用し、全成分か明確な失敗を返す', () => {
  it('同じ鍵の形が読込み待ち中に入れ替わっても、借りた旧形を比較後まで保つ', async () => {
    const shapes = cache(), old = box(shapes, 'before', 10); box(shapes, 'after', 20);
    const started = latch(), resume = latch();
    const api = createKernelApi(async () => { started.open(); await resume.promise; return oc; }, shapes);
    const pending = api.compareMaterials({ beforeKeys: ['before', 'before'], afterKeys: ['after'] });
    await started.promise;
    const replacement = box(shapes, 'before', 30);
    try { expect(old.deleted).not.toHaveBeenCalled(); expect(shapes.delete('before')).toBe(false); }
    finally { resume.open(); await pending; }
    const result = await pending;
    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error(JSON.stringify(result));
    expect(result.result.beforeVolume).toBeCloseTo(1000, 6);
    expect(result.result.afterVolume).toBeCloseTo(8000, 6);
    expect(result.result.added.volume).toBeCloseTo(7000, 6);
    expect(old.deleted).toHaveBeenCalledTimes(1); expect(replacement.deleted).not.toHaveBeenCalled();
    expect(shapes.delete('before')).toBe(true);
  });

  it('一方の所有者が閉じても比較の貸出が残り、中止後に両入力を解放できる', async () => {
    const shapes = cache(), old = box(shapes, 'old', 10), next = box(shapes, 'next', 20);
    const owner = shapes.acquire(['old']), started = latch(), resume = latch(); let cancelled = false;
    const pending = compareCachedMaterials({ beforeKeys: ['old'], afterKeys: ['next'] }, shapes,
      async () => { started.open(); await resume.promise; return oc; }, () => cancelled);
    await started.promise;
    try {
      shapes.release(owner);
      expect(shapes.delete('old')).toBe(false); expect(old.deleted).not.toHaveBeenCalled();
    } finally { cancelled = true; resume.open(); await pending; }
    expect(await pending).toEqual({ kind: 'cancelled' });
    expect(shapes.delete('old')).toBe(true); expect(shapes.delete('next')).toBe(true);
    expect(old.deleted).toHaveBeenCalledTimes(1); expect(next.deleted).toHaveBeenCalledTimes(1);
  });

  it('欠落した鍵・読込み失敗・中止確認の例外では空の比較を返さず、貸出を戻す', async () => {
    const shapes = cache(); box(shapes, 'available', 10);
    const loader = vi.fn(() => Promise.resolve(oc));
    const missing = await compareCachedMaterials({ beforeKeys: ['available'], afterKeys: ['missing'] }, shapes, loader);
    expect(missing.kind).toBe('failed'); expect(loader).not.toHaveBeenCalled();
    const request = { beforeKeys: ['available'], afterKeys: ['available'] };
    expect(await compareCachedMaterials(request, shapes, () => Promise.reject(new Error('読込み不能')))).toEqual({ kind: 'failed', message: '読込み不能' });
    expect(await compareCachedMaterials(request, shapes, loader, () => { throw new Error('中止確認不能'); })).toEqual({ kind: 'failed', message: '中止確認不能' });
    expect(shapes.delete('available')).toBe(true);
  });

  it('重なった複数ボディを二重計上せず、同じ材料集合の分割だけでは差を作らない', async () => {
    const shapes = cache(), outer = box(shapes, 'outer', 20); box(shapes, 'inner', 10);
    const result = await createKernelApi(() => Promise.resolve(oc), shapes).compareMaterials({
      beforeKeys: ['outer', 'inner'], afterKeys: ['outer'],
    });
    expect(result.kind).toBe('compared');
    if (result.kind !== 'compared') throw new Error(JSON.stringify(result));
    expect(result.result.added.kind).toBe('empty'); expect(result.result.removed.kind).toBe('empty');
    expect(result.result.common.volume).toBeCloseTo(8000, 6);
    expect(measureVolume(oc, outer.body.shape)).toBeCloseTo(8000, 6);
  });

  it('異常な入力を計算前に断り、明示的な両空集合は体積0として比較する', async () => {
    const shapes = cache(), loader = vi.fn(() => Promise.resolve(oc));
    for (const request of [null, {}, { beforeKeys: [null], afterKeys: [] }, { beforeKeys: [''], afterKeys: [] },
      { beforeKeys: Array.from({ length: 1025 }, () => 'same'), afterKeys: [] }]) {
      expect((await compareCachedMaterials(request, shapes, loader)).kind).toBe('failed');
    }
    expect(loader).not.toHaveBeenCalled();
    const result = await compareCachedMaterials({ beforeKeys: [], afterKeys: [] }, shapes, loader);
    expect(result).toEqual({ kind: 'compared', result: { added: { kind: 'empty', volume: 0, mesh: null },
      removed: { kind: 'empty', volume: 0, mesh: null }, common: { kind: 'empty', volume: 0, mesh: null }, beforeVolume: 0, afterVolume: 0 } });
  });
});
