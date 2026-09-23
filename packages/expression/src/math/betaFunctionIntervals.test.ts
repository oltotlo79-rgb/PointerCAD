import { describe, expect, it } from 'vitest';
import { betaFunctionRanges, betaFunctionSample } from './betaFunctionIntervals.js';
import { betaFunctionDecimal } from './betaFunctionNumeric.js';
import { BETA_FUNCTION_REFERENCES } from './betaFunctionReferences.js';
import { logGammaPositiveRange, gammaFunctionSample } from './gammaFunctionIntervals.js';
import { decimalRational } from './exactRational.js';
import { nextFloat, type MathInterval } from './mathInterval.js';

const point = (x: number): MathInterval => ({ lower: x, upper: x });
function contains(range: MathInterval | null, expected: number): void {
  expect(range).not.toBeNull();
  if (range === null) throw new Error('Missing enclosure');
  expect(range.lower).toBeLessThanOrEqual(expected); expect(range.upper).toBeGreaterThanOrEqual(expected);
}
const finite = BETA_FUNCTION_REFERENCES.filter(row => row.slice(2).every(value =>
  Number.isFinite(Number(value)) && Number(value) !== 0));

describe('Betaの値と二つの引数の一階・二階微分を区間で囲む', () => {
  it.each(finite)('B(%s,%s)の値と混合項を別の計算部の数値微分へ照合する', (a,b,value,da,db,daa,dbb,dab) => {
    const result = betaFunctionRanges(point(Number(a)), point(Number(b)));
    contains(result.value,Number(value)); contains(result.da,Number(da)); contains(result.db,Number(db));
    contains(result.daa,Number(daa)); contains(result.dbb,Number(dbb)); contains(result.dab,Number(dab));
  });
  it.each([[0.1,1,0.2,2],[1,2,2,4],[31.5,32.5,63.5,64.5],[100,120,200,220]])(
    '箱[%s,%s]×[%s,%s]の中の値を端の単調性で囲む', (al,au,bl,bu) => {
      const result = betaFunctionRanges({lower:al,upper:au},{lower:bl,upper:bu});
      for (let i=0;i<=4;i++) for (let j=0;j<=4;j++) {
        const a=decimalRational(String(al+(au-al)*i/4)), b=decimalRational(String(bl+(bu-bl)*j/4));
        if(a===null || b===null) throw new Error('Invalid sample');
        contains(result.value, Number(betaFunctionDecimal(a,b,()=>undefined)));
      }
      for (const range of Object.values(result)) expect(range).not.toBeNull();
    });
  it('既知の値を含み、個々のGammaが桁あふれしてもBetaは有限のまま使う', () => {
    expect(betaFunctionSample(1,4)).toBeCloseTo(0.25,14);
    expect(betaFunctionSample(0.5,0.5)).toBeCloseTo(Math.PI,10);
    expect(Number.isNaN(gammaFunctionSample(19999))).toBe(true);
    contains(betaFunctionRanges(point(19999),point(1)).value,1/19999);
    expect(betaFunctionSample(19999,1)).toBeCloseTo(1/19999,14);
  });
  it('成立しない領域・非有限値・逆順・和の上限を正確に拒否する', () => {
    for (const [a,b] of [[point(0),point(1)],[point(-0.5),point(2)],
      [{lower:-0.01,upper:0.01},point(1)],[point(1),{lower:0,upper:2}],
      [{lower:2,upper:1},point(1)],[point(NaN),point(1)],[point(1),point(Infinity)],
      [point(20000),point(1e-100)],[point(nextFloat(19999,1)),point(1)]]) {
      expect(Object.values(betaFunctionRanges(a,b)).every(value=>value===null)).toBe(true);
    }
  });
  it('小さすぎる値・大きすぎる値を0や有限な点へ置き換えない', () => {
    expect(Number.isNaN(betaFunctionSample(10000,10000))).toBe(true);
    expect(Number.isNaN(betaFunctionSample(1e-310,1))).toBe(true);
    expect(Number.isFinite(betaFunctionSample(1e-100,1))).toBe(true);
  });
  it('対数Gammaの入口は正の実数の範囲を検査し、中間の指数を作らない', () => {
    contains(logGammaPositiveRange(point(1)),0); contains(logGammaPositiveRange(point(3)),Math.LN2);
    const large=logGammaPositiveRange(point(20000));
    expect(large).not.toBeNull(); expect(Number.isFinite(large?.upper)).toBe(true);
    for (const value of [point(0),point(-1),point(NaN),point(Infinity),point(20001),{lower:2,upper:1}]) {
      expect(logGammaPositiveRange(value)).toBeNull();
    }
  });
});
