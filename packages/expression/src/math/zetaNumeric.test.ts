import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { decimalRational,type ExactRational } from './exactRational.js';
import { zetaValue } from './zetaNumeric.js';
import { ZETA_REFERENCES } from './zetaReferences.js';
import { MathInputProblem } from './mathInputContract.js';
const D=Decimal.clone({precision:330,rounding:Decimal.ROUND_HALF_EVEN});
const proceed=()=>undefined;
function rational(source:string):ExactRational {
  const input=decimalRational(source);if(input===null)throw new Error('Invalid test input');return input;
}
const number=(input:ExactRational)=>new D(input.numerator.toString()).div(input.denominator.toString());
const value=(source:string)=>zetaValue(rational(source),proceed);
describe('ゼータ関数の実数の解析接続を余りの範囲とともに求める',()=>{
  it.each(ZETA_REFERENCES)('zeta(%s)を独立した400/520桁の値と照合する',(source,reference)=>{
    const answer=value(source),expected=new D(reference);
    expect(number(answer.lower).lte(expected)).toBe(true);
    expect(number(answer.upper).gte(expected)).toBe(true);
    expect(answer.decimal).toBe(expected.toSignificantDigits(40).toString());
    expect(answer.corrections).toBeLessThanOrEqual(128);
  },30_000);
  it.each([['0','-0.5'],['-1',new D(-1).div(12).toSignificantDigits(40).toString()],
    ['-3',new D(1).div(120).toSignificantDigits(40).toString()],
    ['-5',new D(-1).div(252).toSignificantDigits(40).toString()],['-7',new D(1).div(240).toSignificantDigits(40).toString()]])('zeta(%s)の整数の恒等式を元の分数のまま返す',(source,expected)=>{
    const answer=value(source);expect(answer.lower).toEqual(answer.upper);expect(answer.decimal).toBe(expected);
  });
  it('負の偶数の零と、その両側の微小な非零を区別する',()=>{
    for(let k=2;k<=32;k+=2)expect(value(String(-k)).decimal).toBe('0');
    for(const source of ['-2.00000000000000000001','-1.99999999999999999999'])expect(value(source).decimal).not.toBe('0');
  },30_000);
  it('1の発散、実数範囲外、不正な分母、中止を拒否する',()=>{
    expect(()=>value('1')).toThrow('発散');
    for(const source of ['-32.0000000001','128.0000000001'])expect(()=>value(source)).toThrow('範囲');
    expect(()=>zetaValue({numerator:1n,denominator:0n},proceed)).toThrow(MathInputProblem);
    let steps=0;
    expect(()=>zetaValue(rational('.5'),()=>{if(++steps===10)throw new Error('中止');})).toThrow('中止');
  });
  it('整数の基本値を再計算しても反復量を抑え、同じ40桁と誤差範囲を保つ',()=>{
    for(const source of ['2','4','128']) {
      let steps=0;
      const answer=zetaValue(rational(source),()=>{if(++steps>512)throw new Error('整数の再計算の処理量が上限を超えました');});
      const reference=ZETA_REFERENCES.find(([input])=>input===source);
      if(reference===undefined)throw new Error('独立した比較値がありません: '+source);
      const expected=new D(reference[1]);
      expect(answer.decimal).toBe(expected.toSignificantDigits(40).toString());
      expect(number(answer.lower).lte(expected)&&number(answer.upper).gte(expected)).toBe(true);
    }
  });
  it('負の偶数に近すぎて40桁を確定できない場合は0を返さず精度不足とする',()=>{
    const denominator=10n**500n;
    expect(()=>zetaValue({numerator:-2n*denominator+1n,denominator},proceed)).toThrow('桁数');
  },30_000);
});
