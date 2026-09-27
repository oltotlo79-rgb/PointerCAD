import { describe, expect, it } from 'vitest';
import { gammaFunctionRanges, gammaFunctionSample } from './gammaFunctionIntervals.js';
import { GAMMA_FUNCTION_REFERENCES } from './gammaFunctionReferences.js';
import { gammaFunctionDecimal } from './gammaFunctionNumeric.js';
import { decimalRational } from './exactRational.js';
import type { MathInterval } from './mathInterval.js';

function contains(interval: MathInterval | null, expected: number): void {
  expect(interval).not.toBeNull();
  if (interval === null) throw new Error('Missing enclosure');
  expect(interval.lower).toBeLessThanOrEqual(expected);
  expect(interval.upper).toBeGreaterThanOrEqual(expected);
}
const finiteReferences = GAMMA_FUNCTION_REFERENCES.filter(([, value, first, second]) =>
  [value, first, second].every(text => Number.isFinite(Number(text)) && Number(text) !== 0));

describe('Gamma関数の作図範囲と一階・二階微分は全域を囲む', () => {
  it.each(finiteReferences)('x=%sで値と微分を独立な数値で確認する', (input, value, first, second) => {
    const x = Number(input), range = gammaFunctionRanges({ lower: x, upper: x });
    contains(range.value, Number(value)); contains(range.first, Number(first)); contains(range.second, Number(second));
    expect(Math.abs((gammaFunctionSample(x)-Number(value))/Number(value))).toBeLessThan(5e-11);
  });
  it.each([[-4.9,-4.1], [-1.9,-1.1], [-0.8,-0.2], [0.01,0.9], [1,2], [1.4,1.5], [31.8,32.2], [99,100]])(
    '[%s,%s]の内部と最小値近傍を両端だけの判定で除外しない', (lower, upper) => {
      const ranges = gammaFunctionRanges({ lower, upper });
      for (let index = 0; index <= 16; index++) {
        const x = lower+(upper-lower)*index/16, rational = decimalRational(String(x));
        if (rational === null) throw new Error('Invalid sample');
        contains(ranges.value, Number(gammaFunctionDecimal(rational, () => undefined)));
      }
      expect(ranges.first).not.toBeNull(); expect(ranges.second).not.toBeNull();
    });
  it.each([[-2.1,-1.9], [-1,0], [-0.1,0.1], [0,1], [-3,-3], [-Infinity,1], [1,Infinity], [2,1]])(
    '[%s,%s]の極・非有限値・逆順を連続な区間として返さない', (lower, upper) => {
      expect(gammaFunctionRanges({ lower, upper })).toEqual({ value: null, first: null, second: null });
    });
  it('整数のすぐ左右を結ばず、左右それぞれの符号を保持する', () => {
    for (const pole of [-10,-2,-1,0]) {
      const left = gammaFunctionSample(pole-2**-30), right = gammaFunctionSample(pole+2**-30);
      expect(Number.isFinite(left)).toBe(true); expect(Number.isFinite(right)).toBe(true);
      expect(Math.sign(left)).toBe(-Math.sign(right));
      expect(Number.isNaN(gammaFunctionSample(pole))).toBe(true);
    }
  });
  it('極のない負の区間全体で半整数の最大・最小を含み、0近傍も丸めない', () => {
    for (const [lower, upper] of [[-3.99,-3.01],[-2.99,-2.01],[-0.99,-0.01]]) {
      const range = gammaFunctionRanges({ lower, upper });
      const rational = decimalRational(String(Math.floor(lower)+0.5));
      if (rational === null) throw new Error('Invalid midpoint');
      contains(range.value, Number(gammaFunctionDecimal(rational, () => undefined)));
    }
    contains(gammaFunctionRanges({ lower: -1e-100, upper: -1e-100 }).value, -1e100);
  });
  it('作図で表せない大きさ・小ささを0や有限値へ変えない', () => {
    for (const x of [20000,-19998.5,1e-310,Infinity,NaN]) expect(Number.isNaN(gammaFunctionSample(x))).toBe(true);
  });
});
