import { describe, expect, it } from 'vitest';

import {
  closedOffsetDistance,
  createOffsetCache,
  offsetCacheKey,
  offsetDisplacement,
  offsetSideOf,
} from './offsetMath.js';
import type { ResolvedCurve } from './types.js';
import type { Vec3 } from './vec3.js';

/** 40×30 の長方形(反時計回り、XY 平面)。 */
const RECTANGLE: readonly ResolvedCurve[] = [
  { kind: 'segment', featureId: 'r1', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', featureId: 'r1', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', featureId: 'r1', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', featureId: 'r1', from: [0, 30, 0], to: [0, 0, 0] },
];

const UP: Vec3 = [0, 0, 1];
const FORWARD: Vec3 = [1, 0, 0];

describe('オフセットの鍵(FR-321、NFR-PF-3)', () => {
  it('同じ材料からは同じ鍵、距離が変われば違う鍵になる', () => {
    const base = { curves: RECTANGLE, distance: 5, side: 'outside', corner: 'round' } as const;
    expect(offsetCacheKey(base)).toBe(offsetCacheKey(base));
    expect(offsetCacheKey({ ...base, distance: 5.000000001 })).not.toBe(offsetCacheKey(base));
  });

  it('側と角が変われば違う鍵になる(同じ形を別の側と取り違えない)', () => {
    const base = { curves: RECTANGLE, distance: 5, side: 'outside', corner: 'round' } as const;
    expect(offsetCacheKey({ ...base, side: 'inside' })).not.toBe(offsetCacheKey(base));
    expect(offsetCacheKey({ ...base, corner: 'sharp' })).not.toBe(offsetCacheKey(base));
  });

  it('元の曲線が動けば鍵も変わる(上流が変われば作り直す)', () => {
    const base = { curves: RECTANGLE, distance: 5, side: 'outside', corner: 'round' } as const;
    const moved: readonly ResolvedCurve[] = [
      { kind: 'segment', featureId: 'r1', from: [0, 0, 0], to: [41, 0, 0] },
      ...RECTANGLE.slice(1),
    ];
    expect(offsetCacheKey({ ...base, curves: moved })).not.toBe(offsetCacheKey(base));
  });

  it('曲線の本数が違えば鍵も変わる', () => {
    const base = { curves: RECTANGLE, distance: 5, side: 'outside', corner: 'round' } as const;
    expect(offsetCacheKey({ ...base, curves: RECTANGLE.slice(0, 3) })).not.toBe(
      offsetCacheKey(base),
    );
  });

  it('16 桁の 16 進文字列になる(cacheKeyFor と同じ形)', () => {
    const key = offsetCacheKey({
      curves: RECTANGLE,
      distance: 5,
      side: 'outside',
      corner: 'round',
    });
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('閉じた輪郭の符号(FR-321、2026-09-04 の実測)', () => {
  it('外側は正、内側は負', () => {
    expect(closedOffsetDistance(5, 'outside')).toBe(5);
    expect(closedOffsetDistance(5, 'inside')).toBe(-5);
  });

  it('距離 0 はどちら側でも 0(元と同じ形)', () => {
    expect(closedOffsetDistance(0, 'outside')).toBe(0);
    expect(closedOffsetDistance(0, 'inside')).toBe(-0);
  });
});

describe('開いた曲線の左右の判定(FR-321)', () => {
  it('上が +Z・進む向きが +X のとき、+Y へのずれは左(outside)', () => {
    expect(offsetSideOf([0, 5, 0], FORWARD, UP)).toBe('outside');
  });

  it('同じ条件で -Y へのずれは右(inside)', () => {
    expect(offsetSideOf([0, -5, 0], FORWARD, UP)).toBe('inside');
  });

  it('上向きが逆なら左右も入れ替わる', () => {
    expect(offsetSideOf([0, 5, 0], FORWARD, [0, 0, -1])).toBe('inside');
  });

  it('ずれが 0(距離 0)なら判定しない', () => {
    expect(offsetSideOf([0, 0, 0], FORWARD, UP)).toBeNull();
  });

  it('進む向きが上向きと平行なら判定しない', () => {
    expect(offsetSideOf([0, 5, 0], UP, UP)).toBeNull();
  });

  it('ずれの向きが左右と直交していれば判定しない', () => {
    // 進む向きに沿ったずれ(左右の成分が無い)。
    expect(offsetSideOf([5, 0, 0], FORWARD, UP)).toBeNull();
  });
});

describe('出来上がった輪郭のずれ(FR-321)', () => {
  it('起点に近いほうの端との差を返す', () => {
    expect(offsetDisplacement([0, 0, 0], [0, -5, 0], [25, 15, 0])).toEqual([0, -5, 0]);
  });

  it('向きが逆に返っても、起点に近い端を選ぶ', () => {
    expect(offsetDisplacement([0, 0, 0], [25, 15, 0], [0, -5, 0])).toEqual([0, -5, 0]);
  });
});

describe('オフセットの覚え書き(NFR-PF-2)', () => {
  const CURVES: readonly ResolvedCurve[] = [
    { kind: 'segment', featureId: 'o1', from: [0, 0, 0], to: [1, 0, 0] },
  ];

  it('入れたものを鍵で引ける。無い鍵は null', () => {
    const cache = createOffsetCache();
    expect(cache.get('a')).toBeNull();
    cache.set('a', CURVES);
    expect(cache.get('a')).toEqual(CURVES);
    expect(cache.size).toBe(1);
  });

  it('上限を超えると古いものから捨てる', () => {
    const cache = createOffsetCache(2);
    cache.set('a', CURVES);
    cache.set('b', CURVES);
    cache.set('c', CURVES);
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toEqual(CURVES);
    expect(cache.get('c')).toEqual(CURVES);
  });

  it('引いたものは新しい側へ回るので、次の追加で捨てられない', () => {
    const cache = createOffsetCache(2);
    cache.set('a', CURVES);
    cache.set('b', CURVES);
    expect(cache.get('a')).toEqual(CURVES);
    cache.set('c', CURVES);
    expect(cache.get('a')).toEqual(CURVES);
    expect(cache.get('b')).toBeNull();
  });

  it('同じ鍵へ入れ直しても件数は増えない', () => {
    const cache = createOffsetCache();
    cache.set('a', CURVES);
    cache.set('a', CURVES);
    expect(cache.size).toBe(1);
  });
});
