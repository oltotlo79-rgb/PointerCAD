import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { decimalRational,type ExactRational } from './exactRational.js';
import { airyValues,type AiryBounds,type AiryKind } from './airyNumeric.js';
import { AIRY_REFERENCES } from './airyReferences.js';
import { MathInputProblem } from './mathInputContract.js';

const D=Decimal.clone({precision:310,rounding:Decimal.ROUND_HALF_EVEN});
const proceed=()=>undefined;
function exact(text:string):ExactRational {
  const result=decimalRational(text);if(result===null)throw new Error('Invalid reference input');return result;
}
const decimal=(value:ExactRational)=>new D(value.numerator.toString()).div(value.denominator.toString());
function matches(answer:AiryBounds,expected:string):void {
  const reference=new D(expected);
  expect(decimal(answer.lower).lte(reference)).toBe(true);
  expect(decimal(answer.upper).gte(reference)).toBe(true);
  expect(answer.decimal).toBe(reference.toSignificantDigits(40).toString());
}
describe('Airyの初期値・級数の全残項と丸めを囲み、減衰する小さい答えも保つ',()=>{
  it.each(AIRY_REFERENCES)('%s(%s)の値と一階を別方式の320/420桁と照合する',(kind,x,value,first)=>{
    const result=airyValues(kind,exact(x),proceed);
    matches(result.value,value);matches(result.first,first);
    expect(result.terms).toBeLessThan(4096);
  },30_000);
  it('正の大きい入力のAiとBiの大小・符号・単調性を取り違えない',()=>{
    for(const kind of ['Ai','Bi'] as const) {
      const values=['0','8','32'].map(x=>airyValues(kind,exact(x),proceed));
      for(const answer of values) {
        expect(new D(answer.value.decimal).gt(0)).toBe(true);
        expect(kind==='Ai'?new D(answer.first.decimal).lt(0):new D(answer.first.decimal).gt(0)).toBe(true);
      }
      for(let index=1;index<values.length;index++) {
        const comparison=new D(values[index].value.decimal).cmp(values[index-1].value.decimal);
        expect(comparison).toBe(kind==='Ai'?-1:1);
      }
      expect(kind==='Ai'?new D(values[2].value.decimal).lt('1e-50'):new D(values[2].value.decimal).gt('1e50')).toBe(true);
    }
  });
  it.each(['-32','0','32'])('二つの独立解のWronskianは入力%sでも1/piとなる',x=>{
    const ai=airyValues('Ai',exact(x),proceed),bi=airyValues('Bi',exact(x),proceed);
    const determinant=new D(ai.value.decimal).mul(bi.first.decimal).sub(new D(ai.first.decimal).mul(bi.value.decimal));
    expect(determinant.sub(new D(1).div(D.acos(-1))).abs().lt('1e-37')).toBe(true);
  });
  it.each(['Ai','Bi'] as const)('%sの一階の変化が元の方程式yの二階=x*yを満たす',kind=>{
    const h=new D('1e-10');
    for(const source of ['-10','0','10']) {
      const x=new D(source),center=airyValues(kind,exact(source),proceed);
      const left=airyValues(kind,exact(x.sub(h).toString()),proceed);
      const right=airyValues(kind,exact(x.add(h).toString()),proceed);
      const difference=new D(right.first.decimal).sub(left.first.decimal).div(h.mul(2));
      const expected=x.mul(center.value.decimal);
      expect(difference.sub(expected).abs().div(D.max(1,expected.abs())).lt('1e-18')).toBe(true);
    }
  });
  it('演算範囲を定義域と混同せず、過大な入力・不正な分母を拒否する',()=>{
    for(const kind of ['Ai','Bi'] as const) {
      for(const x of ['-32.0001','32.0001'])expect(()=>airyValues(kind,exact(x),proceed)).toThrow('この計算');
      for(const value of [{numerator:1n,denominator:0n},{numerator:1n,denominator:-1n},
        {numerator:1n<<8192n,denominator:1n},{numerator:1n,denominator:1n<<8192n}]) {
        expect(()=>airyValues(kind,value,proceed)).toThrow(MathInputProblem);
      }
    }
  });
  it('開始前と級数の途中の中止を完了値へ置き換えない',()=>{
    const stopped=new MathInputProblem('budget','利用者による中止');
    for(const kind of ['Ai','Bi'] satisfies readonly AiryKind[])for(const stopAt of [1,4,20,80]) {
      let calls=0;
      expect(()=>airyValues(kind,exact('32'),()=>{if(++calls===stopAt)throw stopped;})).toThrow(stopped);
      expect(calls).toBe(stopAt);
    }
  });
});
