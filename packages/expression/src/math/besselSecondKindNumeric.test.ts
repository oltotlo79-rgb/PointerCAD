import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, type ExactRational } from './exactRational.js';
import { secondBesselDecimal, secondBesselBound } from './besselSecondKindNumeric.js';
import { BESSEL_FIXED_SCALE as S, type BesselFixedRange } from './besselFixedRange.js';
import { besselConstants, besselLog } from './besselConstants.js';
import { BESSEL_SECOND_REFERENCES, BESSEL_CONSTANT_REFERENCES } from './besselSecondKindReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D=Decimal.clone({precision:600,rounding:Decimal.ROUND_HALF_EVEN});
const proceed=()=>undefined;
function exact(text:string):ExactRational {
  const value=decimalRational(text);if(value===null)throw new Error('Invalid reference input');return value;
}
function enclose(range:BesselFixedRange,text:string):void {
  const reference=new D(text),scale=new D(S.toString());
  const lower=new D(range.lower.toString()).div(scale),upper=new D(range.upper.toString()).div(scale);
  // The independent reference is rounded to 260 digits, not an exact constant.
  // Its last-place uncertainty can exceed our bound (e.g. K1(1e-100)).
  const referenceError=new D(10).pow(reference.e-259);
  expect(lower.lte(reference.add(referenceError))).toBe(true);
  expect(upper.gte(reference.sub(referenceError))).toBe(true);
  expect(upper.sub(lower).div(reference.abs()).lt('1e-70')).toBe(true);
}

describe('正の実数の整数次数YとKを残差付きで計算する',()=>{
  it('独立基準は実数で有限かつ非零で、Kの値と二階微分は正・一階微分は負',()=>{
    for(const [kind,,,...values] of BESSEL_SECOND_REFERENCES) {
      for(const text of values) {
        expect(text).toMatch(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/u);
        expect(new D(text).isFinite()).toBe(true);expect(new D(text).isZero()).toBe(false);
      }
      if(kind==='K') {
        expect(new D(values[0]).gt(0)).toBe(true);expect(new D(values[1]).lt(0)).toBe(true);expect(new D(values[2]).gt(0)).toBe(true);
      }
    }
  });
  it.each(BESSEL_SECOND_REFERENCES)('%s_%s(%s)の40桁と証明の範囲を独立した340/480桁の基準で照合する',(kind,n,x,value)=>{
    enclose(secondBesselBound(kind,n,exact(x),proceed),value);
    expect(secondBesselDecimal(kind,n,exact(x),proceed)).toBe(new D(value).toSignificantDigits(40).toString());
  });
  it('円周率・Euler定数・対数を丸めた定数として扱わず上下限で囲む',()=>{
    const constants=besselConstants(proceed);
    const [pi,gamma,ln2,small,large]=BESSEL_CONSTANT_REFERENCES;
    enclose(constants.pi,pi);enclose(constants.gamma,gamma);enclose(constants.ln2,ln2);
    enclose(besselLog(exact('1e-100'),proceed),small);enclose(besselLog(exact('128'),proceed),large);
    expect(besselLog(exact('1'),proceed)).toEqual({lower:0n,upper:0n});
    const inverse=besselLog(exact('0.5'),proceed);
    expect(inverse).toEqual({lower:-constants.ln2.upper,upper:-constants.ln2.lower});
  });
  it('負の整数次数の偶奇を保ち、非常に大きい結果を有限の表示文字として保持する',()=>{
    for(const kind of ['Y','K'] as const) for(const n of [0,1,2,7,128]) {
      const positive=new D(secondBesselDecimal(kind,n,exact('0.125'),proceed));
      const negative=new D(secondBesselDecimal(kind,-n,exact('0.125'),proceed));
      expect(negative.eq(positive.mul(kind==='Y'&&n%2===1?-1:1))).toBe(true);
      if(n===128) { expect(positive.isFinite()).toBe(true);expect(Number.isFinite(positive.toNumber())).toBe(false); }
    }
  });
  it('原点・負軸・次数と元の分数の上限を検査してから計算する',()=>{
    for(const kind of ['Y','K'] as const) {
      for(const x of ['0','-1'])expect(()=>secondBesselDecimal(kind,0,exact(x),proceed)).toThrow('正の実数');
      for(const n of [129,-129,0.5,NaN,Infinity])expect(()=>secondBesselDecimal(kind,n,exact('1'),proceed)).toThrow(MathInputProblem);
      expect(()=>secondBesselDecimal(kind,0,exact('128.0000000000000000000000000000000000000000001'),proceed)).toThrow('128以下');
      for(const input of [{numerator:1n,denominator:0n},{numerator:1n,denominator:-1n},
        {numerator:1n<<8192n,denominator:1n},{numerator:1n,denominator:1n<<8192n}]) {
        expect(()=>secondBesselDecimal(kind,0,input,proceed)).toThrow(MathInputProblem);
      }
    }
  });
  it('開始直後・対数や級数の途中の中止を成功に変えない',()=>{
    const stopped=new MathInputProblem('budget','利用者による中止');
    for(const kind of ['Y','K'] as const)for(const stopAt of [1,10,100]) {
      let calls=0;
      expect(()=>secondBesselDecimal(kind,128,exact('128'),()=>{if(++calls===stopAt)throw stopped;})).toThrow(stopped);
      expect(calls).toBe(stopAt);
    }
    expect(()=>besselConstants(()=>{throw stopped;})).toThrow(stopped);
  });
});
