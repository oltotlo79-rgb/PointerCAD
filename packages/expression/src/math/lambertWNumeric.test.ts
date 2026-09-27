import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decimalRational, type ExactRational } from './exactRational.js';
import { lambertWBounds } from './lambertWNumeric.js';
import { LAMBERT_W_REFERENCES } from './lambertWReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D=Decimal.clone({precision:260,rounding:Decimal.ROUND_HALF_EVEN});
const proceed=()=>undefined;
function exact(text:string):ExactRational {
  const value=decimalRational(text);if(value===null)throw new Error('Invalid reference input');return value;
}
const decimal=(value:ExactRational)=>new D(value.numerator.toString()).div(value.denominator.toString());

describe('Lambert Wの実数二枝は指数の残項も囲んで値を確定する',()=>{
  it.each(LAMBERT_W_REFERENCES)('枝%s・入力%sを独立した値と上下限で照合する',(branch,x,expected)=>{
    const answer=lambertWBounds(branch,exact(x),proceed),reference=new D(expected),value=new D(answer.decimal);
    expect(decimal(answer.lower).lte(reference)).toBe(true);
    expect(decimal(answer.upper).gte(reference)).toBe(true);
    expect(value.toString()).toBe(reference.toSignificantDigits(40).toString());
    expect(value.mul(value.exp()).sub(x).abs().div(new D(x).abs()).lt('1e-36')).toBe(true);
    expect(branch===0?value.gte(-1):value.lte(-1)).toBe(true);
    expect(answer.iterations).toBeLessThan(1024);
  },30_000);
  it('同じ負の入力の二つの解を混同せず、大小関係と単調性を保つ',()=>{
    const principal=['-0.3','-0.2','-0.1'].map(x=>new D(lambertWBounds(0,exact(x),proceed).decimal));
    const secondary=['-0.3','-0.2','-0.1'].map(x=>new D(lambertWBounds(-1,exact(x),proceed).decimal));
    for(let index=0;index<2;index++) {
      expect(principal[index].lt(principal[index+1])).toBe(true);
      expect(secondary[index].gt(secondary[index+1])).toBe(true);
      expect(principal[index].gt(secondary[index])).toBe(true);
    }
  });
  it('0の主枝だけを0とし、別の枝と0に近い非零を区別する',()=>{
    expect(lambertWBounds(0,exact('0'),proceed).decimal).toBe('0');
    expect(()=>lambertWBounds(-1,exact('0'),proceed)).toThrow(MathInputProblem);
    for(const x of ['-1e-1000','1e-1000']) {
      expect(new D(lambertWBounds(0,exact(x),proceed).decimal).isZero()).toBe(false);
    }
  });
  it('元の実数領域の外と正確な入力の資源上限を拒否する',()=>{
    for(const branch of [0,-1] as const) expect(()=>lambertWBounds(branch,exact('-0.368'),proceed)).toThrow('以上');
    expect(()=>lambertWBounds(-1,exact('1e-1000'),proceed)).toThrow('0未満');
    for(const input of [{numerator:1n,denominator:0n},{numerator:1n,denominator:-1n},
      {numerator:1n<<8192n,denominator:1n},{numerator:1n,denominator:1n<<8192n}]) {
      expect(()=>lambertWBounds(0,input,proceed)).toThrow(MathInputProblem);
    }
  });
  it('開始前・指数計算・枝の探索途中で同じ中止理由を返す',()=>{
    const stopped=new MathInputProblem('budget','利用者による中止');
    for(const at of [1,4,20,80]) {
      let calls=0;
      expect(()=>lambertWBounds(-1,exact('-0.1'),()=>{if(++calls===at)throw stopped;})).toThrow(stopped);
      expect(calls).toBe(at);
    }
  });
});
