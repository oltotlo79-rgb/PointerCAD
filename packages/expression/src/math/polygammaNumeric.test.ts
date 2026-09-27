import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, rational } from './exactRational.js';
import { polygammaDecimal } from './polygammaNumeric.js';
import { POLYGAMMA_REFERENCES, POLYGAMMA_NEAR_POLE_REFERENCES, DIGAMMA_ZERO_NEARBY } from './polygammaReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D = Decimal.clone({ precision: 100 });
const proceed = () => undefined;
function value(order: number, text: string): string {
  const input = decimalRational(text);
  if (input === null) throw new Error('Invalid reference input');
  return polygammaDecimal(order, input, proceed);
}
function relative(actual: string, expected: string): number {
  return new D(actual).sub(expected).div(expected).abs().toNumber();
}

describe('Gammaの微分に必要なpsiと高階値を実数の元の分数から求める', () => {
  it.each(POLYGAMMA_REFERENCES)('%s階・引数%sを独立な240桁計算と照合する', (order, input, expected) => {
    expect(relative(value(order, input), expected)).toBeLessThan(1e-38);
  });
  it.each(POLYGAMMA_NEAR_POLE_REFERENCES)('%s階・極近傍の分子%sを整数へ丸めない', (order, numerator, denominator, expected) => {
    const input = rational(BigInt(numerator), BigInt(denominator));
    if (input === null) throw new Error('Invalid reference fraction');
    expect(relative(polygammaDecimal(order, input, proceed), expected)).toBeLessThan(1e-38);
  });
  it('Euler定数・π²/6と半整数の式、結果全文の有効40桁を保つ', () => {
    expect(value(0, '1')).toBe('-0.5772156649015328606065120900824024310422');
    expect(value(1, '1')).toBe('1.644934066848226436472415166646025189219');
    expect(relative(value(1, '0.5'), D.acos(-1).pow(2).div(2).toString())).toBeLessThan(1e-38);
    expect(relative(value(0, '-0.5'), new D(value(0, '0.5')).add(2).toString())).toBeLessThan(1e-37);
  });
  it.each([0,1,2,7,15,17])('%s階の漸化式を正負の区間で保つ', order => {
    let factorial = new D(1);
    for (let index = 2; index <= order; index++) factorial = factorial.mul(index);
    for (const x of ['-3.25','-0.25','0.25','31.5']) {
      const before = new D(value(order, x));
      const correction = factorial.mul(order % 2 === 0 ? 1 : -1).div(new D(x).pow(order+1));
      const after = new D(value(order, new D(x).add(1).toString()));
      // The recurrence subtracts two already rounded 40-digit outputs. Scale
      // its residual by the operands, not the much smaller cancelled result.
      // Each returned value is separately checked at relative 1e-38 above.
      expect(after.sub(before).sub(correction).abs().div(before.abs().add(correction.abs())).toNumber()).toBeLessThan(2e-38);
    }
  });
  it('0と負の整数・不正な次数と分母は計算前に拒否する', () => {
    for (const x of ['0','-1','-2','-19999']) expect(() => value(1, x)).toThrow('0と負の整数');
    for (const order of [-1,0.5,18,Infinity,NaN]) expect(() => value(order, '1')).toThrow('次数は0から17');
    for (const denominator of [0n,-1n]) expect(() => polygammaDecimal(0, { numerator: 1n, denominator }, proceed)).toThrow(MathInputProblem);
    for (const x of ['20001','-19999.5']) expect(() => value(0, x)).toThrow(MathInputProblem);
  });
  it('桁落ちで必要な桁数を確定できない値を0や確定値にしない', () => {
    expect(() => value(0, DIGAMMA_ZERO_NEARBY)).toThrow('必要な桁数で確定できません');
  });
  it('繰り返し計算の途中でも中止する', () => {
    const stopped = new MathInputProblem('budget', '利用者による中止');
    let calls = 0;
    expect(() => polygammaDecimal(17, { numerator: 1n, denominator: 2n }, () => {
      if (++calls === 4) throw stopped;
    })).toThrow(stopped);
    expect(calls).toBe(4);
  });
});
