import { describe, expect, it } from 'vitest';
import { polygammaRange, polygammaSample } from './polygammaIntervals.js';
import { polygammaDecimal } from './polygammaNumeric.js';
import { POLYGAMMA_REFERENCES } from './polygammaReferences.js';
import { decimalRational } from './exactRational.js';
import type { MathInterval } from './mathInterval.js';

function contains(range: MathInterval | null, expected: number): void {
  expect(range).not.toBeNull();
  if (range === null) throw new Error('Missing range');
  expect(range.lower).toBeLessThanOrEqual(expected);
  expect(range.upper).toBeGreaterThanOrEqual(expected);
}

describe('Gammaの微分式も範囲全体と元の極を保持する', () => {
  it.each(POLYGAMMA_REFERENCES)('%s階・引数%sを独立な値で囲む', (order, text, expected) => {
    const input = Number(text);
    contains(polygammaRange(order, { lower: input, upper: input }), Number(expected));
    // Near a reflected half-integer cancellation may widen the enclosure.
    expect(Math.abs(polygammaSample(order, input)-Number(expected))/Math.max(1,Math.abs(Number(expected)))).toBeLessThan(1e-9);
  });
  it.each([0,1,2,7,15,17])('%s階の正負の区間は内部と半整数の値も含む', order => {
    for (const [lower, upper] of [[-3.9,-3.1],[-0.9,-0.1],[0.1,0.9],[1.4,1.5],[31.8,32.2],[127.8,128.2]]) {
      const range = polygammaRange(order, { lower, upper });
      for (let index = 0; index <= 8; index++) {
        const input = decimalRational(String(lower+(upper-lower)*index/8));
        if (input === null) throw new Error('Invalid sample');
        contains(range, Number(polygammaDecimal(order, input, () => undefined)));
      }
    }
  });
  it('極を含む区間、不正な次数、非有限値を連続な値にしない', () => {
    for (const [lower, upper] of [[-2.1,-1.9],[-1,0],[-0.1,0.1],[0,1],[-3,-3],[-Infinity,1],[1,Infinity],[2,1],[-20000,-19999.5]]) {
      expect(polygammaRange(0, { lower, upper })).toBeNull();
    }
    for (const order of [-1,0.5,18,Infinity,NaN]) expect(polygammaRange(order, { lower: 1, upper: 1 })).toBeNull();
  });
  it('0のすぐ近くを0へ丸めず、表現不能な大きさでは値を捏造しない', () => {
    contains(polygammaRange(0, { lower: -1e-100, upper: -1e-100 }), 1e100);
    contains(polygammaRange(1, { lower: 1e-100, upper: 1e-100 }), 1e200);
    expect(Number.isNaN(polygammaSample(17, 1e-100))).toBe(true);
    expect(Number.isNaN(polygammaSample(0, 0))).toBe(true);
  });
});
