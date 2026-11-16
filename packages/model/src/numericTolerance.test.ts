/**
 * 数の大きさを許容差と比べる共通の口が、Math.abs で書いた元の式と同じ真偽を返す事
 * (境界のちょうどの値と、その前後の隣の浮動小数、負の値、0、NaN、Infinity)。
 */
import { describe, expect, it } from 'vitest';

import { belowMagnitude, exceedsMagnitude, withinMagnitude } from './numericTolerance.js';

/** value の隣の浮動小数(direction が正なら大きい方、負なら小さい方)。有限の値だけに使う。 */
function adjacentFloat(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const awayFromZero = (value > 0) === (direction > 0);
  view.setBigUint64(0, awayFromZero ? bits + 1n : bits - 1n);
  return view.getFloat64(0);
}

const BOUNDS = [1e-9, 1e-6, 0.5, 1, 0, Number.MIN_VALUE, Infinity, NaN];

function valuesAround(bound: number): number[] {
  const edges = Number.isFinite(bound) ? [bound, -bound] : [];
  const neighbours = edges.flatMap((edge) => [adjacentFloat(edge, -1), adjacentFloat(edge, 1)]);
  return [...edges, ...neighbours, 0, -0, 1e-12, -1e-12, 2, -2, 1e300, -1e300, Infinity, -Infinity, NaN];
}

describe('数の大きさを許容差と比べる共通の口', () => {
  it('どの境界でも、境界のちょうど・前後の隣・負・0・NaN・Infinity で Math.abs の式と同じ真偽を返す', () => {
    let compared = 0;
    for (const bound of BOUNDS) {
      for (const value of valuesAround(bound)) {
        expect(withinMagnitude(value, bound), `within ${value} ${bound}`).toBe(Math.abs(value) <= bound);
        expect(belowMagnitude(value, bound), `below ${value} ${bound}`).toBe(Math.abs(value) < bound);
        expect(exceedsMagnitude(value, bound), `exceeds ${value} ${bound}`).toBe(Math.abs(value) > bound);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });

  it('境界のちょうどの値は、以下 と 超える は分かれ、未満 は偽', () => {
    const bound = 1e-9;
    for (const value of [bound, -bound]) {
      expect([withinMagnitude(value, bound), belowMagnitude(value, bound), exceedsMagnitude(value, bound)]).toEqual([true, false, false]);
    }
    const outside = adjacentFloat(bound, 1);
    expect([withinMagnitude(-outside, bound), belowMagnitude(-outside, bound), exceedsMagnitude(-outside, bound)]).toEqual([false, false, true]);
    const inside = adjacentFloat(bound, -1);
    expect([withinMagnitude(-inside, bound), belowMagnitude(-inside, bound), exceedsMagnitude(-inside, bound)]).toEqual([true, true, false]);
  });

  it('NaN の時は 3 つとも偽', () => {
    const cases: ReadonlyArray<readonly [number, number]> = [[NaN, 1], [1, NaN], [NaN, NaN]];
    for (const [value, bound] of cases) {
      expect([withinMagnitude(value, bound), belowMagnitude(value, bound), exceedsMagnitude(value, bound)]).toEqual([false, false, false]);
    }
  });
});
