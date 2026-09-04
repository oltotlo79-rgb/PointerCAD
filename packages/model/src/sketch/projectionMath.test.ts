import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { WORK_PLANES } from './planeMath.js';
import {
  createProjectionCache,
  projectionCacheKey,
  PROJECTION_CACHE_CAPACITY,
  type ProjectionKeyMaterial,
} from './projectionMath.js';
import type { ResolvedCurve } from './types.js';

const FACE: SubShapeRef = {
  bodyFeatureId: 'extrude-1',
  index: 4,
  fingerprint: {
    kind: 'face',
    surfaceKind: 'plane',
    area: 1200,
    position: [20, 15, 10],
    axis: [0, 0, 1],
    radius: null,
  },
};

const BASE: ProjectionKeyMaterial = {
  bodyKey: 'body-key-1',
  source: { kind: 'subShape', ref: FACE },
  plane: WORK_PLANES.xy,
};

const ONE_CURVE: readonly ResolvedCurve[] = [
  { kind: 'segment', featureId: 'pj1', from: [0, 0, 0], to: [1, 0, 0] },
];

describe('投影・交差の鍵(FR-325、タスク25)', () => {
  it('同じ材料からは必ず同じ鍵が出る(決定性)', () => {
    expect(projectionCacheKey(BASE)).toBe(projectionCacheKey({ ...BASE }));
  });

  it('もとの立体の鍵が変われば鍵も変わる(上流の変化が必ず伝わる)', () => {
    expect(projectionCacheKey({ ...BASE, bodyKey: 'body-key-2' })).not.toBe(
      projectionCacheKey(BASE),
    );
  });

  it('投影する面が変われば鍵も変わる', () => {
    const other: SubShapeRef = { ...FACE, index: 5 };
    expect(
      projectionCacheKey({ ...BASE, source: { kind: 'subShape', ref: other } }),
    ).not.toBe(projectionCacheKey(BASE));
  });

  it('作図面が変われば鍵も変わる(投影先が違えば別の曲線になる)', () => {
    expect(projectionCacheKey({ ...BASE, plane: WORK_PLANES.xz })).not.toBe(
      projectionCacheKey(BASE),
    );
  });

  it('投影(面を指す)と交差(立体そのもの)は別の鍵になる', () => {
    expect(
      projectionCacheKey({ ...BASE, source: { kind: 'body', bodyFeatureId: 'extrude-1' } }),
    ).not.toBe(projectionCacheKey(BASE));
  });

  it('作図面の id が違っても、位置と向きが同じなら同じ鍵になる', () => {
    const renamed = { ...WORK_PLANES.xy, id: 'plane-9' };
    expect(projectionCacheKey({ ...BASE, plane: renamed })).toBe(projectionCacheKey(BASE));
  });
});

describe('投影・交差の覚え書き(LRU)', () => {
  it('覚えたものを鍵で引ける。無ければ null', () => {
    const cache = createProjectionCache();
    cache.set('k1', ONE_CURVE);

    expect(cache.get('k1')).toEqual(ONE_CURVE);
    expect(cache.get('k2')).toBeNull();
    expect(cache.size).toBe(1);
  });

  it('曲線 0 本(交わらない)も覚える。頼み直しても答えは同じため', () => {
    const cache = createProjectionCache();
    cache.set('k1', []);

    expect(cache.get('k1')).toEqual([]);
  });

  it('容量を超えたら、最後に使ってから最も時間が経ったものから捨てる', () => {
    const cache = createProjectionCache(2);
    cache.set('a', ONE_CURVE);
    cache.set('b', ONE_CURVE);
    // a を使うと、次に捨てられるのは b になる。
    expect(cache.get('a')).toEqual(ONE_CURVE);
    cache.set('c', ONE_CURVE);

    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toEqual(ONE_CURVE);
    expect(cache.get('c')).toEqual(ONE_CURVE);
  });

  it('既定の容量はオフセットと同じ 64 件', () => {
    expect(PROJECTION_CACHE_CAPACITY).toBe(64);
    expect(createProjectionCache().size).toBe(0);
  });
});
