import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, type ExactRational } from './exactRational.js';
import { betaFunctionDecimal } from './betaFunctionNumeric.js';
import { BETA_FUNCTION_REFERENCES } from './betaFunctionReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D = Decimal.clone({ precision: 100 });
const proceed = () => undefined;
function exact(text: string): ExactRational {
  const value = decimalRational(text);
  if (value === null) throw new Error('Invalid reference input');
  return value;
}
const beta = (a: string, b: string) => betaFunctionDecimal(exact(a), exact(b), proceed);
const relative = (a: string, b: string) => new D(a).sub(b).div(b).abs().toNumber();

describe('正の実数Betaは中間のGammaを作らず有効40桁で返す', () => {
  it('独立基準の微小な混合微分が桁不足で0になった記録を使わない', () => {
    for (const [a,b,...values] of BETA_FUNCTION_REFERENCES) {
      expect(new D(a).isPositive() && new D(b).isPositive()).toBe(true);
      // Differentiate the positive defining integral: the log factors give these signs.
      for (const [index,text] of values.entries()) {
        const value=new D(text);
        expect(value.isFinite() && !value.isZero()).toBe(true);
        expect(value.isNegative()).toBe(index===1 || index===2);
      }
    }
  });
  it.each(BETA_FUNCTION_REFERENCES)('B(%s,%s)を独立した400/640桁の計算へ照合する', (a, b, expected) => {
    expect(relative(beta(a, b), expected)).toBeLessThan(1e-38);
    expect(beta(a, b)).toBe(beta(b, a));
  });
  it('既知の値・大きな引数・小さい引数を結果全文で照合する', () => {
    expect(beta('1', '1')).toBe('1'); expect(beta('1', '4')).toBe('0.25');
    expect(beta('2', '3')).toBe('0.08333333333333333333333333333333333333333');
    expect(beta('0.5', '0.5')).toBe('3.141592653589793238462643383279502884197');
    expect(beta('1e-100', '1e-100')).toBe('2e+100');
    const large = beta('10000', '10000');
    expect(new D(large).isPositive()).toBe(true); expect(Number(large)).toBe(0);
  });
  it('二つの引数を動かす漸化式を保つ', () => {
    for (const [a, b] of [['0.25','0.75'],['3.5','6.25'],['100','200']]) {
      const next = beta(new D(a).add(1).toString(), b);
      expect(relative(next, new D(beta(a,b)).mul(a).div(new D(a).add(b)).toString())).toBeLessThan(2e-38);
    }
  });
  it.each([['0','1'],['1','0'],['-0.5','2'],['1','-2']])('正の領域外B(%s,%s)を計算前に拒否する', (a,b) => {
    expect(()=>beta(a,b)).toThrow('どちらも正の実数');
  });
  it('個々の値だけでなく元の正確な和と分母を確認する', () => {
    expect(()=>beta('10001','10000')).toThrow('和は20000以下');
    expect(()=>beta('20000','1e-100')).toThrow('和は20000以下');
    expect(()=>betaFunctionDecimal({numerator:1n,denominator:0n},exact('1'),proceed)).toThrow(MathInputProblem);
    expect(()=>betaFunctionDecimal(exact('1'),{numerator:1n,denominator:-1n},proceed)).toThrow(MathInputProblem);
    expect(()=>betaFunctionDecimal({numerator:1n<<8192n,denominator:1n},exact('1'),proceed)).toThrow(MathInputProblem);
  });
  it('開始時と高精度計算の途中の中止を引き継ぐ', () => {
    const stopped = new MathInputProblem('budget','利用者による中止');
    expect(()=>betaFunctionDecimal(exact('0.5'),exact('0.5'),()=>{throw stopped;})).toThrow(stopped);
    let calls=0;
    expect(()=>betaFunctionDecimal(exact('0.5'),exact('0.5'),()=>{if(++calls===4)throw stopped;})).toThrow(stopped);
    expect(calls).toBe(4);
  });
});
