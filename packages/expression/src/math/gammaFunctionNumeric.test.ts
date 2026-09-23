import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, rational } from './exactRational.js';
import { gammaFunctionDecimal } from './gammaFunctionNumeric.js';
import { GAMMA_FUNCTION_REFERENCES, GAMMA_NEAR_POLE_REFERENCES } from './gammaFunctionReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D = Decimal.clone({ precision: 100 });
const proceed = () => undefined;
function value(text: string): string {
  const exact = decimalRational(text);
  if (exact === null) throw new Error('Invalid reference input');
  return gammaFunctionDecimal(exact, proceed);
}
function relative(actual: string, expected: string): number {
  return new D(actual).sub(expected).div(expected).abs().toNumber();
}

describe('Gamma関数は元の分数で極を判定し、有効40桁の実数を返す', () => {
  it.each(GAMMA_FUNCTION_REFERENCES)('Γ(%s)を独立な200桁計算と照合する', (input, expected) => {
    expect(relative(value(input), expected)).toBeLessThan(1e-38);
  });
  it.each(GAMMA_NEAR_POLE_REFERENCES)('極近傍の元の分子%sを整数へ丸めない', (numerator, denominator, expected) => {
    const input = rational(BigInt(numerator), BigInt(denominator));
    if (input === null) throw new Error('Invalid reference fraction');
    const result = gammaFunctionDecimal(input, proceed);
    expect(relative(result, expected)).toBeLessThan(1e-38);
    expect(new D(result).isNegative()).toBe(new D(expected).isNegative());
  });
  it('階乗・半整数の既知値と、補助桁を含まない結果全文を照合する', () => {
    expect(value('1')).toBe('1'); expect(value('2')).toBe('1'); expect(value('5')).toBe('24');
    expect(value('0.5')).toBe('1.772453850905516027298167483341145182798');
    expect(value('-0.5')).toBe('-3.544907701811032054596334966682290365595');
    expect(value('1e-100')).toBe('1e+100');
  });
  it('正負の引数でGammaの漸化式を保持する', () => {
    for (const input of ['-30.125', '-4.75', '-0.5', '0.125', '1.25', '31.5', '100']) {
      const next = value(new D(input).add(1).toString());
      expect(relative(next, new D(input).mul(value(input)).toString())).toBeLessThan(2e-38);
    }
  });
  it.each(['0', '-1', '-2', '-19999'])('元の引数%sが極なら有限値を作らない', input => {
    expect(() => value(input)).toThrow('Gamma関数には0と負の整数を指定できません。');
  });
  it('計算範囲と不正な分母を計算開始前に拒否する', () => {
    for (const input of ['20001', '-19999.5']) expect(() => value(input)).toThrow('対応する範囲を超えています');
    expect(() => gammaFunctionDecimal({ numerator: 1n, denominator: 0n }, proceed)).toThrow(MathInputProblem);
    expect(() => gammaFunctionDecimal({ numerator: 1n, denominator: -2n }, proceed)).toThrow(MathInputProblem);
  });
  it('開始時だけでなく正の値へ移す途中でも中止できる', () => {
    const input = rational(-1n, 2n);
    if (input === null) throw new Error('Invalid fraction');
    const stopped = new MathInputProblem('budget', '利用者による中止');
    expect(() => gammaFunctionDecimal(input, () => { throw stopped; })).toThrow(stopped);
    let calls = 0;
    expect(() => gammaFunctionDecimal(input, () => { if (++calls === 4) throw stopped; })).toThrow(stopped);
    expect(calls).toBe(4);
  });
});
