import Decimal from 'decimal.js';
import { describe,expect,it } from 'vitest';
import { zetaDerivatives } from './zetaDerivatives.js';
import { zetaValue } from './zetaNumeric.js';
import { decimalRational,type ExactRational } from './exactRational.js';
import { ZETA_DERIVATIVE_REFERENCES } from './zetaDerivativeReferences.js';
const D=Decimal.clone({precision:330,rounding:Decimal.ROUND_HALF_EVEN});
const proceed=()=>undefined;
function rational(source:string):ExactRational {
  const input=decimalRational(source);if(input===null)throw new Error('Invalid test input');return input;
}
const number=(input:ExactRational)=>new D(input.numerator.toString()).div(input.denominator.toString());
describe('ゼータ関数の微分の余りも次数ごとに囲む',()=>{
  it.each(ZETA_DERIVATIVE_REFERENCES)('引数%sで全ての次数を独立した値と照合する',(source,references)=>{
    const values=zetaDerivatives(rational(source),references.length-1,proceed);
    expect(values).toHaveLength(references.length);
    for(const [index,reference] of references.entries()) {
      const expected=new D(reference),actual=values[index];
      const lower=number(actual.lower),upper=number(actual.upper);
      // A rounded reference must be substantially finer than the enclosure.
      // Otherwise the test would reject a correct, very narrow interval.
      if(reference!=='0' && reference!=='-0.5') {
        const referenceUnit=new D(10).pow(expected.e-expected.sd()+1);
        expect(referenceUnit.lt(upper.minus(lower).div(100)),`order ${String(index)} reference precision`).toBe(true);
      }
      expect(lower.lte(expected),`order ${String(index)} lower ${lower.toString()} <= ${reference}`).toBe(true);
      expect(upper.gte(expected),`order ${String(index)} upper ${upper.toString()} >= ${reference}`).toBe(true);
      expect(actual.decimal).toBe(expected.toSignificantDigits(40).toString());
    }
  },30_000);
  it('負の偶数の正確な零に非零の傾きがあり、0階の入口とも一致する',()=>{
    const input=rational('-2'),derivatives=zetaDerivatives(input,2,proceed);
    expect(derivatives[0].decimal).toBe('0');expect(derivatives[1].decimal).not.toBe('0');
    expect(derivatives[0]).toEqual(zetaValue(input,proceed));
    expect(zetaDerivatives(rational('.5'),0,proceed)).toEqual([zetaValue(rational('.5'),proceed)]);
  },30_000);
  it('次数・元の極・中止を先に確認し、途中の微分配列を返さない',()=>{
    for(const order of [-1,1.5,18])expect(()=>zetaDerivatives(rational('2'),order,proceed)).toThrow('17階');
    expect(()=>zetaDerivatives(rational('1'),0,proceed)).toThrow('発散');
    let calls=0;
    expect(()=>zetaDerivatives(rational('.5'),3,()=>{if(++calls===20)throw new Error('中止');})).toThrow('中止');
  });
});
