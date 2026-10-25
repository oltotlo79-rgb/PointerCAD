import { describe, expect, it } from 'vitest';
import type { CurrentOriginIndex } from '../subShapeOrigin.js';
import type { SolidBodyMesh } from '../types.js';
import { OriginCacheBudget, ORIGIN_BODY_MAX_ROWS, originBytes,
  withinBodyOriginBudget, withinReplyOriginBudget } from './originBudget.js';
import { createShapeCache } from './shapeCache.js';

const one: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [{
  origin: { version: 1, shapeKind: 'face', identity: {
    kind: 'box-face', featureId: 'box', role: 'top',
  } }, state: 'unique', current: { kind: 'face', index: 0 },
}] };

describe('origin budgets', () => {
  it('rejects a complete oversized table without leaving a tracked prefix', () => {
    if (one.state !== 'tracked') throw new Error('fixture');
    const huge: CurrentOriginIndex = { version: 1, state: 'tracked',
      bindings: Array.from({ length: ORIGIN_BODY_MAX_ROWS + 1 }, () => one.bindings[0]) };
    expect(originBytes(huge)).toBe(Infinity);
    expect(withinBodyOriginBudget(huge)).toEqual({ version: 1, state: 'untracked', reason: 'limit' });
  });

  it('does not let a cache key replacement count twice and resets after clear', () => {
    const budget = new OriginCacheBudget(originBytes(one));
    const live = new Set(['a', 'b']);
    expect(budget.admit('a', one, true, candidate => live.has(candidate))).toEqual(one);
    expect(budget.admit('a', one, false, candidate => live.has(candidate))).toEqual(one);
    expect(budget.admit('b', one, false, candidate => live.has(candidate)))
      .toEqual({ version: 1, state: 'untracked', reason: 'limit' });
    expect(budget.admit('b', one, true, candidate => live.has(candidate))).toEqual(one);
  });

  it('accounts untracked envelopes and refuses a second live table at the exact byte boundary', () => {
    const untracked: CurrentOriginIndex = { version: 1, state: 'untracked', reason: 'unsupported-producer' };
    const budget = new OriginCacheBudget(originBytes(untracked));
    const live = new Set(['a', 'b']);
    expect(originBytes(untracked)).toBe(new TextEncoder().encode(JSON.stringify(untracked)).length);
    expect(budget.admit('a', untracked, false, key => live.has(key))).toEqual(untracked);
    expect(budget.trackedKeyCount).toBe(1);
    expect(budget.admit('b', untracked, false, key => live.has(key)))
      .toEqual({ version: 1, state: 'untracked', reason: 'limit' });
    expect(budget.trackedKeyCount).toBe(1);
  });

  it('releases a table after ShapeCache eviction and admits the new live key', () => {
    const budget = new OriginCacheBudget(originBytes(one));
    const cache = createShapeCache<{ delete(): void }>(1);
    cache.set('a', { delete: () => undefined });
    expect(budget.admit('a', one, false, candidate => cache.has(candidate))).toEqual(one);
    cache.set('b', { delete: () => undefined });
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(budget.admit('b', one, false, candidate => cache.has(candidate))).toEqual(one);
    expect(budget.trackedKeyCount).toBe(1);
  });

  it('counts the smaller untracked replacement without counting the previous table twice', () => {
    const untracked: CurrentOriginIndex = { version: 1, state: 'untracked', reason: 'unsupported-operation' };
    const budget = new OriginCacheBudget(originBytes(one) + originBytes(untracked));
    const live = new Set(['a', 'b']);
    expect(budget.admit('a', one, false, candidate => live.has(candidate))).toEqual(one);
    expect(budget.admit('a', untracked, false, candidate => live.has(candidate))).toEqual(untracked);
    expect(budget.trackedKeyCount).toBe(1);
    expect(budget.admit('b', one, false, candidate => live.has(candidate))).toEqual(one);
    expect(budget.trackedKeyCount).toBe(2);
  });

  it('refuses a second live tracked table beyond the total cache budget', () => {
    const budget = new OriginCacheBudget(originBytes(one));
    const live = new Set(['a', 'b']);
    expect(budget.admit('a', one, false, candidate => live.has(candidate))).toEqual(one);
    expect(budget.admit('b', one, false, candidate => live.has(candidate)))
      .toEqual({ version: 1, state: 'untracked', reason: 'limit' });
    expect(budget.trackedKeyCount).toBe(1);
  });

  it('drops every reply table together when the aggregate exceeds its budget', () => {
    const body: SolidBodyMesh = { id: 'a', positions: new Float32Array(), normals: new Float32Array(),
      indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0,
      faceCount: 0, edgeCount: 0, volume: 0, bodyKind: 'solid', faces: [], edges: [],
      vertices: [], threadMarks: [], origins: one };
    const result = withinReplyOriginBudget([body, { ...body, id: 'b' }], originBytes(one));
    expect(result.map((entry) => entry.origins)).toEqual([
      { version: 1, state: 'untracked', reason: 'limit' },
      { version: 1, state: 'untracked', reason: 'limit' },
    ]);
    expect(body.origins).toEqual(one);
  });

});


describe('native anonymous proof budgets', () => {
  const region = { current: { kind: 'face', index: 4 }, reason: 'imported' } as const;
  const anonymous: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [], fingerprintFallback: [region] };
  it('counts rows/bytes without any bindings and rejects the complete oversized table', () => {
    expect(originBytes(anonymous)).toBe(new TextEncoder().encode(JSON.stringify(anonymous)).length);
    const huge: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [],
      fingerprintFallback: Array.from({ length: ORIGIN_BODY_MAX_ROWS + 1 }, () => region) };
    expect(originBytes(huge)).toBe(Infinity);
    expect(withinBodyOriginBudget(huge)).toEqual({ version: 1, state: 'untracked', reason: 'limit' });
    const budget = new OriginCacheBudget();
    expect(budget.admit('huge', huge, false, () => true)).toEqual({ version: 1, state: 'untracked', reason: 'limit' });
    expect(budget.trackedKeyCount).toBe(0);
  });
  it('combines named and unnamed rows and releases evicted anonymous metadata', () => {
    if (one.state !== 'tracked') throw new Error('fixture');
    const mixed: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: one.bindings,
      fingerprintFallback: Array.from({ length: ORIGIN_BODY_MAX_ROWS }, () => region) };
    expect(originBytes(mixed)).toBe(Infinity);
    const budget = new OriginCacheBudget(originBytes(anonymous));
    expect(budget.admit('a', anonymous, false, () => true)).toEqual(anonymous);
    expect(budget.admit('a', anonymous, false, () => true)).toEqual(anonymous);
    expect(budget.admit('b', anonymous, false, key => key === 'b')).toEqual(anonymous);
    expect(budget.trackedKeyCount).toBe(1);
  });
});


describe('all-table reply and link limits', () => {
  it('rejects anonymous additions that alone exceed the existing aggregate link budget', () => {
    if (one.state !== 'tracked') throw new Error('fixture');
    const first = one.bindings[0];
    if (first === undefined) throw new Error('origin missing');
    const split = { origin: first.origin, state: 'split', candidates: [
      { kind: 'face', index: 0 }, { kind: 'face', index: 1 }, { kind: 'face', index: 2 },
      { kind: 'face', index: 3 }, { kind: 'face', index: 4 },
    ] } as const;
    const table: CurrentOriginIndex = { version: 1, state: 'tracked',
      bindings: Array.from({ length: 80_000 }, () => split), fingerprintFallback: [
        { current: { kind: 'face', index: 5 }, reason: 'imported' },
      ] };
    expect(originBytes(table)).toBe(Infinity);
    expect(withinBodyOriginBudget(table)).toEqual({ version: 1, state: 'untracked', reason: 'limit' });
  });
  it('counts cloned anonymous and untracked tables in an all-or-none reply without changing geometry', () => {
    const anonymous: CurrentOriginIndex = { version: 1, state: 'tracked', bindings: [], fingerprintFallback: [
      { current: { kind: 'face', index: 0 }, reason: 'legacy' },
    ] };
    const untracked: CurrentOriginIndex = { version: 1, state: 'untracked', reason: 'imported' };
    const body: SolidBodyMesh = { id: 'a', positions: Float32Array.of(0, 0, 0), normals: new Float32Array(),
      indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0,
      faceCount: 0, edgeCount: 0, volume: 12000, bodyKind: 'solid', faces: [], edges: [], vertices: [], threadMarks: [], origins: anonymous };
    const bodies = [body, { ...body, id: 'b', origins: untracked }];
    const limit = originBytes(anonymous) + originBytes(untracked);
    const clone: readonly SolidBodyMesh[] = structuredClone(bodies);
    expect(withinReplyOriginBudget(clone, limit)).toBe(clone);
    const rejected = withinReplyOriginBudget(clone, limit - 1);
    expect(rejected.map(entry => entry.origins)).toEqual([
      { version: 1, state: 'untracked', reason: 'limit' }, { version: 1, state: 'untracked', reason: 'limit' },
    ]);
    expect(rejected.map(entry => entry.volume)).toEqual([12000, 12000]);
    expect(rejected[0].positions).toBe(clone[0].positions);
    expect(bodies[0].origins).toEqual(anonymous);
  });
});
