import { afterEach, describe, expect, it, vi } from 'vitest';
import * as allocationModule from '../occt/allocations.js';
import { createShapeCache } from './shapeCache.js';

afterEach(() => { vi.restoreAllMocks(); });

function entry(failure?: Error) {
  let deletes = 0;
  return {
    backing: new ArrayBuffer(8),
    calls: () => deletes,
    delete(): void {
      deletes += 1;
      if (failure !== undefined) throw failure;
    },
  };
}

function observeTransfers() {
  const create = allocationModule.createAllocations;
  const kept: allocationModule.OcctDeletable[] = [];
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const group = create();
    return { release: group.release, keep<T extends allocationModule.OcctDeletable>(item: T): T {
      kept.push(item);
      return group.keep(item);
    } };
  });
  return kept;
}

describe('shape cache allocation disposal boundary', () => {
  it('borrows and restores retired identities without allocating a second owner', () => {
    const kept = observeTransfers();
    const cache = createShapeCache<ReturnType<typeof entry>>(3);
    const original = entry(), replaced = entry(), latest = entry();
    cache.set('body', original);
    const token = cache.acquire(['body', 'body']);
    const secondToken = cache.acquire(['body']);
    cache.set('body', replaced); cache.set('body', latest); cache.set('body', original);
    expect(cache.get('body')).toBe(original);
    expect(kept).toEqual([]);
    expect([original.calls(), replaced.calls(), latest.calls()]).toEqual([0, 0, 0]);
    cache.release(token);
    expect(kept).toEqual([]);
    cache.release(secondToken);
    expect(kept).toEqual([replaced, latest]);
    expect([original.calls(), replaced.calls(), latest.calls()]).toEqual([0, 1, 1]);
    cache.release(secondToken);
    cache.clear(); cache.clear();
    expect(kept).toEqual([replaced, latest, original]);
    expect(cache.stats()).toMatchObject({ released: 3, shapeCount: 0, protectedKeyCount: 0 });
  });

  it('preserves get-based LRU and protects a borrowed entry through caller cancellation cleanup', () => {
    const kept = observeTransfers();
    const cache = createShapeCache<ReturnType<typeof entry>>(2);
    const a = entry(), b = entry(), c = entry();
    cache.set('a', a); cache.set('b', b);
    const token = cache.acquire(['a']);
    const cancelled = new Error('caller cancelled before publication');
    try {
      expect(cache.get('a')).toBe(a);
      cache.set('c', c);
      expect([a.calls(), b.calls(), c.calls()]).toEqual([0, 1, 0]);
      expect(cache.delete('a')).toBe(false);
      throw cancelled;
    } catch (error) {
      expect(error).toBe(cancelled);
    } finally { cache.release(token); }
    expect(kept).toEqual([b]);
    expect(cache.get('a')).toBe(a);
    expect(cache.retain(['a'])).toBe(1);
    expect(cache.delete('a')).toBe(true);
    cache.clear();
    expect([a.calls(), b.calls(), c.calls()]).toEqual([1, 1, 1]);
    expect(cache.stats()).toMatchObject({ evictions: 1, released: 3, protectedKeyCount: 0 });
  });

  it('retains failed-release evidence, attempts other retired entries and never repeats an opaque failing delete', () => {
    const kept = observeTransfers();
    const cause = new Error('opaque delete failed after native cleanup');
    const failed = entry(cause), retired = entry(), active = entry();
    const cache = createShapeCache<ReturnType<typeof entry>>(3, undefined, item => [item.backing]);
    cache.set('body', failed);
    const token = cache.acquire(['body']);
    cache.set('body', retired); cache.set('body', active);
    let first: unknown;
    try { cache.release(token); } catch (error) { first = error; }
    expect(first).toBeInstanceOf(AggregateError);
    expect([failed.calls(), retired.calls(), active.calls()]).toEqual([1, 1, 0]);
    expect(cache.failedReleaseBuffers?.(token)).toEqual([failed.backing]);
    try { cache.release(token); } catch (error) { expect(error).toBe(first); }
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect([failed.calls(), retired.calls(), active.calls()]).toEqual([1, 1, 1]);
    expect(kept).toEqual([failed, retired, active]);
    expect(cache.cleanupFailureCount?.()).toBe(1);
    expect(cache.stats()).toMatchObject({ released: 2, shapeCount: 1 });
  });

  it('keeps ownership inside the cache for both replacement and trim failures', () => {
    const cause = new Error('old native release failed');
    const before = createShapeCache<ReturnType<typeof entry>>(1);
    const old = entry(cause), replacement = entry();
    before.set('same', old);
    expect(() => before.set('same', replacement)).toThrow(cause);
    expect(before.get('same')).toBe(replacement);
    expect(replacement.calls()).toBe(0);
    // Failed replacement still transfers ownership; only the cache may dispose it.
    expect(() => before.clear()).toThrow('Shape cache clear partially failed');
    expect([old.calls(), replacement.calls()]).toEqual([1, 1]);

    const after = createShapeCache<ReturnType<typeof entry>>(1);
    const evicted = entry(cause), adopted = entry();
    after.set('old-key', evicted);
    expect(() => after.set('new-key', adopted)).toThrow(cause);
    expect(after.get('new-key')).toBe(adopted);
    expect(adopted.calls()).toBe(0);
    // Here trim failed after touch(); the cache retains the new owner's responsibility.
    expect(() => after.clear()).toThrow('Shape cache clear partially failed');
    expect([evicted.calls(), adopted.calls()]).toEqual([1, 1]);
  });
});
