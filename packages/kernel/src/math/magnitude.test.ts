/**
 * 数の大きさを許容差と比べる共通の口(`magnitude.ts`)が、Math.abs で書いた元の式と同じ真偽を返す事
 * (境界のちょうどの値と、その前後の隣の浮動小数、負の値、0、負の許容差、NaN、Infinity)。
 * 真偽の照らしはこの 1 か所に置く(L-19。もとは kernel の occt/tolerances.test.ts と model の numericTolerance.test.ts の 2 か所。
 * 出し直しの道〔kernel の tolerances.ts・model の橋と numericTolerance.ts〕は packages/test-utils の splineArithmeticBoundary.test.ts が見る)。
 */
import { describe, expect, it } from 'vitest';

import { GEOMETRIC_CONFUSION_MM } from '../occt/tolerances.js';
import { belowMagnitude, exceedsMagnitude, magnitudeAtLeast, withinMagnitude } from './magnitude.js';

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

const BOUNDS = [1e-9, 1e-6, 0.5, 1, 0, -1, Number.MIN_VALUE, Infinity, -Infinity, NaN];

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
        expect(magnitudeAtLeast(value, bound), `at least ${value} ${bound}`).toBe(Math.abs(value) >= bound);
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

describe('値の大きさが許容差を超えるか(exceedsMagnitude)', () => {
  /** 元の手書きの式。共通の口がこれと同じ真偽を返す事を、境界・符号・0・NaN・無限で確かめる。 */
  const original = (value: number, bound: number): boolean => Math.abs(value) > bound;
  const bounds = [0, GEOMETRIC_CONFUSION_MM, 1e-10, 1, Number.POSITIVE_INFINITY, Number.NaN];
  const values = [0, -0, 1e-10, -1e-10, GEOMETRIC_CONFUSION_MM, -GEOMETRIC_CONFUSION_MM, 2e-7, -2e-7, 1, -1, 1.5, -1.5,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN];

  it.each(bounds)('許容差 %s の時、どの値でも元の式 Math.abs(value) > bound と同じ真偽', (bound) => {
    for (const value of values) expect(exceedsMagnitude(value, bound), `value=${String(value)}`).toBe(original(value, bound));
  });

  it('境界の値ちょうどは超えない(> の向き)、少しでも外は超える。NaN は超えない', () => {
    expect(exceedsMagnitude(GEOMETRIC_CONFUSION_MM, GEOMETRIC_CONFUSION_MM)).toBe(false);
    expect(exceedsMagnitude(-GEOMETRIC_CONFUSION_MM, GEOMETRIC_CONFUSION_MM)).toBe(false);
    expect(exceedsMagnitude(2e-7, GEOMETRIC_CONFUSION_MM)).toBe(true);
    expect(exceedsMagnitude(-2e-7, GEOMETRIC_CONFUSION_MM)).toBe(true);
    expect(exceedsMagnitude(Number.NaN, 1)).toBe(false);
    expect(exceedsMagnitude(1, Number.NaN)).toBe(false);
  });
});

describe('値の大きさを許容差と比べる残りの口(withinMagnitude・belowMagnitude・magnitudeAtLeast)', () => {
  /** 元の手書きの式。境界・符号・0・負の許容差・NaN・無限で、共通の口が同じ真偽を返す事を確かめる。 */
  const bounds = [0, GEOMETRIC_CONFUSION_MM, 1e-10, 1, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN];
  const values = [0, -0, 1e-10, -1e-10, GEOMETRIC_CONFUSION_MM, -GEOMETRIC_CONFUSION_MM, 2e-7, -2e-7, 1, -1, 1.5, -1.5,
    Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN];

  it.each(bounds)('許容差 %s の時、どの値でも Math.abs(value) の <=・<・>= と同じ真偽', (bound) => {
    for (const value of values) {
      expect(withinMagnitude(value, bound), `within value=${String(value)}`).toBe(Math.abs(value) <= bound);
      expect(belowMagnitude(value, bound), `below value=${String(value)}`).toBe(Math.abs(value) < bound);
      expect(magnitudeAtLeast(value, bound), `at least value=${String(value)}`).toBe(Math.abs(value) >= bound);
    }
  });
});
