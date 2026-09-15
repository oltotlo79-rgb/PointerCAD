import { describe, expect, it } from 'vitest';
import { intervalUnion, unionFlatMap, unionMap, unionReciprocal, type IntervalUnion } from './mathIntervalUnion.js';

describe('区間の統合で端点・不連続・独立した範囲を保持する', () => {
  it.each([
    { ranges: [], continuous: true },
    { ranges: [], continuous: false },
    { ranges: [{ lower: -0, upper: 0 }], continuous: true },
    { ranges: [{ lower: Number.MIN_VALUE, upper: Number.MAX_VALUE }], continuous: true },
    { ranges: [{ lower: -Infinity, upper: Infinity }], continuous: false },
    { ranges: [{ lower: 1, upper: 2 }], continuous: false },
  ] satisfies IntervalUnion[])('空・単一区間の端点と連続性を変更しない: %j', input => {
    const result = unionFlatMap(intervalUnion(0), () => input);
    expect(result).toEqual(input);
    expect(result.ranges).not.toBe(input.ranges);
  });

  it('入力の配列と端点を変更せず、重なる範囲だけをまとめる', () => {
    const ranges = Object.freeze([
      Object.freeze({ lower: 5, upper: 8 }), Object.freeze({ lower: -3, upper: -1 }),
      Object.freeze({ lower: 2, upper: 5 }), Object.freeze({ lower: 3, upper: 4 }),
    ]);
    const result = unionFlatMap(intervalUnion(0), () => ({ ranges, continuous: false }));
    expect(result).toEqual({ ranges: [{ lower: -3, upper: -1 }, { lower: 2, upper: 8 }], continuous: false });
    expect(ranges.map(range => range.lower)).toEqual([5, -3, 2, 3]);
  });

  it('8区間は独立して保持し、9区間以上は全てを包む有限の範囲にまとめる', () => {
    const ranges = Array.from({ length: 9 }, (_, index) => ({ lower: index * 3, upper: index * 3 + 1 }));
    expect(unionFlatMap(intervalUnion(0), () => ({ ranges: ranges.slice(0, 8), continuous: true })))
      .toEqual({ ranges: ranges.slice(0, 8), continuous: true });
    expect(unionFlatMap(intervalUnion(0), () => ({ ranges, continuous: false })))
      .toEqual({ ranges: [{ lower: 0, upper: 25 }], continuous: false });
  });

  it('極の両側をつながず、片側の定義域を除外しても不連続を保持する', () => {
    const pole = unionReciprocal(intervalUnion(-1, 1));
    expect(pole.continuous).toBe(false);
    expect(pole.ranges).toHaveLength(2);
    expect(pole.ranges[0].upper).toBeLessThan(0);
    expect(pole.ranges[1].lower).toBeGreaterThan(0);
    const positive = unionMap(pole, range => range.upper < 0
      ? { status: 'outside-domain' } : { status: 'range', interval: range });
    expect(positive).toEqual({ ranges: [pole.ranges[1]], continuous: false });
    const empty = unionMap(positive, () => ({ status: 'outside-domain' }));
    expect(empty).toEqual({ ranges: [], continuous: false });
  });
});
