// Reference data was prepared independently at 800 and 1000 decimal digits.
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, type ExactRational } from './exactRational.js';
import { complexErrorFunctionValue } from './complexErrorFunctionNumeric.js';
import { COMPLEX_ERROR_REFERENCES } from './complexErrorFunctionReferences.js';
import { BESSEL_FIXED_SCALE as S } from './besselFixedRange.js';
import { MathInputProblem } from './mathInputContract.js';
const D = Decimal.clone({ precision: 380, rounding: Decimal.ROUND_HALF_EVEN });
const proceed = () => undefined;
function rational(text: string): ExactRational {
  const result = decimalRational(text);
  if (result === null) throw new Error('Invalid test argument');
  return result;
}
const value = (id: 'erf' | 'erfc', a: string, b: string) =>
  complexErrorFunctionValue(id, rational(a), rational(b), proceed);
describe('複素数の誤差関数は両成分の誤差と微小な値を保つ', () => {
  it.each(COMPLEX_ERROR_REFERENCES)('実部$realと虚部$imaginaryの両関数を独立した800/1000桁計算と照合する', reference => {
    for (const id of ['erf', 'erfc'] as const) {
      const result = value(id, reference.real, reference.imaginary);
      for (const [index, part] of [result.real, result.imaginary].entries()) {
        const expected = new D(reference[id][index]);
        expect(new D(part.bounds.lower.toString()).div(S.toString()).lte(expected)).toBe(true);
        expect(new D(part.bounds.upper.toString()).div(S.toString()).gte(expected)).toBe(true);
        expect(new D(part.decimal).toString()).toBe(expected.toSignificantDigits(40).toString());
        expect(part.decimal).toBe(expected.toSignificantDigits(40).toString());
      }
      expect(result.terms).toBeLessThanOrEqual(4096);
    }
  }, 30_000);
  it('共役・奇対称・補関数と軸の正確な零を保持する', () => {
    const original = value('erf', '1.25', '0.75');
    const conjugate = value('erf', '1.25', '-0.75');
    const negative = value('erf', '-1.25', '-0.75');
    expect(conjugate.real.decimal).toBe(original.real.decimal);
    expect(new D(conjugate.imaginary.decimal).neg().toString()).toBe(new D(original.imaginary.decimal).toString());
    expect(new D(negative.real.decimal).neg().toString()).toBe(new D(original.real.decimal).toString());
    expect(new D(negative.imaginary.decimal).neg().toString()).toBe(new D(original.imaginary.decimal).toString());
    expect(value('erf', '0', '3').real.bounds).toEqual({ lower: 0n, upper: 0n });
    expect(value('erfc', '3', '0').imaginary.bounds).toEqual({ lower: 0n, upper: 0n });
    const complement = value('erfc', '1.25', '0.75');
    expect(new D(complement.real.decimal).add(original.real.decimal).sub(1).abs().lt('1e-39')).toBe(true);
  });
  it('開始前と反復中に中止し、途中の数値を返さない', () => {
    for (const stopAt of [1, 5, 100]) {
      let calls = 0;
      const stopped = new MathInputProblem('budget', '中止しました');
      expect(() => complexErrorFunctionValue('erf', rational('8'), rational('8'),
        () => { if (++calls === stopAt) throw stopped; })).toThrow(stopped);
      expect(calls).toBe(stopAt);
    }
  });
  it('入力範囲・保持上限・不正な分母を拒否する', () => {
    for (const pair of [['8.0001', '0'], ['0', '-8.0001']]) expect(() => value('erf', pair[0], pair[1])).toThrow(MathInputProblem);
    expect(() => complexErrorFunctionValue('erfc', { numerator: 1n, denominator: 0n }, rational('1'), proceed)).toThrow(MathInputProblem);
    expect(() => complexErrorFunctionValue('erf', { numerator: 1n, denominator: 1n << 8192n }, rational('1'), proceed)).toThrow(MathInputProblem);
  });
  it('解像度より小さな非零を確定できない場合は零へ置き換えない', () => {
    expect(() => value('erf', '1e-1000', '1')).toThrow('桁数');
  }, 30_000);
});
