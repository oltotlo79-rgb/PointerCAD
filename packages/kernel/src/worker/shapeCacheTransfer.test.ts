import { describe, expect, it } from 'vitest';
import { createShapeCache } from './shapeCache.js';

function owned(name: string, failure?: Error) {
  let count = 0;
  const backing = new ArrayBuffer(8);
  return {
    name, backing,
    calls: () => count,
    delete(): void {
      count += 1;
      if (failure !== undefined) throw failure;
    },
  };
}

type Entry = ReturnType<typeof owned>;
function cacheOf(capacity = 2) {
  return createShapeCache<Entry>(capacity, undefined, value => [value.backing]);
}

describe('shape cache consumes ownership before a fallible replacement', () => {
  it('retains the new owner when the old destructor throws and releases it once on clear', () => {
    const failure = new Error('old destructor failed');
    const cache = cacheOf(1);
    const old = owned('old', failure), replacement = owned('replacement');
    cache.set('body', old);
    const epoch = cache.meshOwnershipEpoch?.();
    expect(() => cache.set('body', replacement)).toThrow(failure);
    expect(cache.get('body')).toBe(replacement);
    expect([old.calls(), replacement.calls()]).toEqual([1, 0]);
    expect(cache.meshOwnershipEpoch?.()).not.toBe(epoch);
    expect(cache.meshBufferSnapshot?.()).toEqual({ status: 'known',
      active: [replacement.backing], retired: [old.backing], protected: [old.backing] });
    const snapshot = cache.meshBufferSnapshot?.();
    if (snapshot?.status !== 'known') throw new Error('Ownership buffers must remain measurable');
    expect(snapshot.active[0]).toBe(replacement.backing);
    expect(snapshot.retired[0]).toBe(old.backing);
    expect(cache.stats()).toMatchObject({ size: 1, shapeCount: 2, released: 0,
      meshByteCounts: { status: 'known', activeBytes: 8, retiredBytes: 8, protectedBytes: 8, totalBytes: 16 } });
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect([old.calls(), replacement.calls()]).toEqual([1, 1]);
    expect(cache.cleanupFailureCount?.()).toBe(1);
    expect(cache.stats()).toMatchObject({ size: 0, shapeCount: 1, released: 1 });
  });

  it('quarantines a replacement cleanup failure too without retrying either destructor', () => {
    const oldFailure = new Error('old failure'), newFailure = new Error('new failure');
    const cache = cacheOf(1);
    const old = owned('old', oldFailure), replacement = owned('new', newFailure);
    cache.set('body', old);
    expect(() => cache.set('body', replacement)).toThrow(oldFailure);
    expect(cache.get('body')).toBe(replacement);
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect([old.calls(), replacement.calls()]).toEqual([1, 1]);
    expect(cache.cleanupFailureCount?.()).toBe(2);
    expect(cache.stats()).toMatchObject({ size: 0, shapeCount: 2, released: 0,
      meshByteCounts: { status: 'known', activeBytes: 0, retiredBytes: 16, protectedBytes: 16, totalBytes: 16 } });
  });

  it('retains ownership after another key fails during trim, then recovers by replacing the valid entry', () => {
    const failure = new Error('evicted destructor failed');
    const cache = cacheOf(1);
    const evicted = owned('evicted', failure), admitted = owned('admitted'), recovered = owned('recovered');
    cache.set('old-key', evicted);
    expect(() => cache.set('new-key', admitted)).toThrow(failure);
    expect(cache.get('new-key')).toBe(admitted);
    expect(cache.get('old-key')).toBeUndefined();
    cache.set('new-key', recovered);
    expect(cache.get('new-key')).toBe(recovered);
    expect([evicted.calls(), admitted.calls(), recovered.calls()]).toEqual([1, 1, 0]);
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect([evicted.calls(), admitted.calls(), recovered.calls()]).toEqual([1, 1, 1]);
    expect(cache.cleanupFailureCount?.()).toBe(1);
  });

  it('keeps a failed self-eviction owned even though get cannot return the just-submitted entry', () => {
    const failure = new Error('new entry partially deleted');
    const cache = cacheOf(1);
    const protectedEntry = owned('protected'), submitted = owned('submitted', failure);
    cache.set('protected', protectedEntry);
    const token = cache.acquire(['protected']);
    expect(() => cache.set('new', submitted)).toThrow(failure);
    // `get(new) !== submitted` is not evidence of caller ownership.
    expect(cache.get('new')).toBeUndefined();
    expect(submitted.calls()).toBe(1);
    expect(cache.meshBufferSnapshot?.()).toEqual({ status: 'known',
      active: [protectedEntry.backing], retired: [submitted.backing],
      protected: [protectedEntry.backing, submitted.backing] });
    const snapshot = cache.meshBufferSnapshot?.();
    if (snapshot?.status !== 'known') throw new Error('Failed self-eviction must retain its actual backing');
    expect(snapshot.retired[0]).toBe(submitted.backing);
    cache.release(token);
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect([protectedEntry.calls(), submitted.calls()]).toEqual([1, 1]);
  });

  it('may fully dispose a submitted unprotected entry during trim without returning ownership', () => {
    const cache = cacheOf(1);
    const protectedEntry = owned('protected'), submitted = owned('submitted');
    cache.set('protected', protectedEntry);
    const token = cache.acquire(['protected']);
    cache.set('new', submitted);
    expect(cache.get('new')).toBeUndefined();
    expect(submitted.calls()).toBe(1);
    expect(cache.stats()).toMatchObject({ size: 1, evictions: 1, released: 1 });
    cache.release(token);
    cache.clear(); cache.clear();
    expect([protectedEntry.calls(), submitted.calls()]).toEqual([1, 1]);
  });

  it('does not dispose identical or restored borrowed entries until their last protection is released', () => {
    const cache = cacheOf(3);
    const original = owned('original'), next = owned('next'), latest = owned('latest');
    cache.set('body', original); cache.set('body', original);
    const first = cache.acquire(['body', 'body']), second = cache.acquire(['body']);
    cache.set('body', next); cache.set('body', latest); cache.set('body', original);
    expect(cache.get('body')).toBe(original);
    expect([original.calls(), next.calls(), latest.calls()]).toEqual([0, 0, 0]);
    cache.release(first);
    expect([original.calls(), next.calls(), latest.calls()]).toEqual([0, 0, 0]);
    cache.release(second); cache.release(second);
    expect([original.calls(), next.calls(), latest.calls()]).toEqual([0, 1, 1]);
    cache.clear(); cache.clear();
    expect([original.calls(), next.calls(), latest.calls()]).toEqual([1, 1, 1]);
    expect(cache.stats()).toMatchObject({ size: 0, shapeCount: 0, protectedKeyCount: 0, released: 3 });
  });

  it('clear invalidates live protection once and preserves the release failure evidence', () => {
    const failure = new Error('retired destructor failed');
    const cache = cacheOf(2);
    const retired = owned('retired', failure), active = owned('active');
    cache.set('body', retired);
    const token = cache.acquire(['body']);
    cache.set('body', active);
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    cache.release(token); cache.release(token);
    expect(() => cache.clear()).toThrow('Shape cache clear partially failed');
    expect([retired.calls(), active.calls()]).toEqual([1, 1]);
    expect(cache.stats()).toMatchObject({ clearWithActiveTokensCount: 1, protectedKeyCount: 0,
      size: 0, shapeCount: 1, released: 1 });
  });
});
