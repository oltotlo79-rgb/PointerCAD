import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { BESSEL_SECOND_REFERENCES } from './besselSecondKindReferences.js';
import { secondBesselRanges } from './besselSecondKindIntervals.js';
import { exactDouble } from './exactDoubleInterval.js';
import { nextFloat, type MathInterval } from './mathInterval.js';
import { MathInputProblem } from './mathInputContract.js';

const D=Decimal.clone({precision:320});
function double(value:number):Decimal {
  const exact=exactDouble(value);if(exact===null)throw new Error('Finite interval required');
  return new D(exact.numerator.toString()).div(exact.denominator.toString());
}
function contains(range:MathInterval|null,value:string):void {
  expect(range).not.toBeNull();if(range===null)throw new Error('Missing enclosure');
  expect(double(range.lower).lte(value)).toBe(true);expect(double(range.upper).gte(value)).toBe(true);
}
const dyadic=BESSEL_SECOND_REFERENCES.filter(([,n,x])=>['1','3','128','0.125'].includes(x)&&!(Math.abs(n)===128&&x==='0.125'));
describe('YとKの値と二階までの微分を正の範囲全体で囲む',()=>{
  it.each(dyadic)('%s_%s(%s)の点の値と微分を独立基準で囲む',(kind,n,x,v,d1,d2)=>{
    const result=secondBesselRanges(kind,n,{lower:Number(x),upper:Number(x)});
    contains(result.value,v);contains(result.first,d1);contains(result.second,d2);
  });
  it.each(dyadic)('%s_%s(%s)を内側に持つ範囲でも全ての微分を囲む',(kind,n,x,v,d1,d2)=>{
    const center=Number(x),width=0.001;
    const result=secondBesselRanges(kind,n,{lower:center-width,upper:Math.min(128,center+width)});
    contains(result.value,v);contains(result.first,d1);contains(result.second,d2);
  });
  it('Yの途中の符号変化を落とさず、Kの正値・単調減少・凸性を保つ',()=>{
    const input={lower:0.8,upper:1.2};
    const y=secondBesselRanges('Y',0,input);
    const k=secondBesselRanges('K',0,input);
    expect(y.value?.lower).toBeLessThan(0);expect(y.value?.upper).toBeGreaterThan(0);
    expect(k.value?.lower).toBeGreaterThan(0);expect(k.first?.upper).toBeLessThan(0);expect(k.second?.lower).toBeGreaterThan(0);
    // All interior points are checked, not only the two endpoints.
    for(let i=0;i<=20;i+=1)for(const kind of ['Y','K'] as const) {
      // 0.8+0.4 is the next double above 1.2. Use the actual bounds, not a rounded nominal width.
      const x=i===0?input.lower:i===20?input.upper:input.lower+(input.upper-input.lower)*i/20;
      expect(x).toBeGreaterThanOrEqual(input.lower);expect(x).toBeLessThanOrEqual(input.upper);
      const point=secondBesselRanges(kind,0,{lower:x,upper:x});
      const box=kind==='Y'?y:k;
      for(const name of ['value','first','second'] as const) {
        const value=point[name];if(value===null)throw new Error('Finite sample required');
        contains(box[name],double(value.lower).toString());contains(box[name],double(value.upper).toString());
      }
    }
  });
  it('原点をまたぐ範囲・未対応の次数・倍精度を超える結果を有限範囲に偽装しない',()=>{
    const empty={value:null,first:null,second:null};
    for(const kind of ['Y','K'] as const) {
      for(const n of [129,-129,0.5,NaN])expect(secondBesselRanges(kind,n,{lower:1,upper:1})).toEqual(empty);
      for(const input of [{lower:0,upper:1},{lower:-1,upper:1},{lower:1,upper:nextFloat(128,1)},
        {lower:2,upper:1},{lower:NaN,upper:1},{lower:1,upper:Infinity}])expect(secondBesselRanges(kind,0,input)).toEqual(empty);
      expect(secondBesselRanges(kind,128,{lower:0.125,upper:0.125})).toEqual(empty);
    }
  });
  it('点と区間でも途中の中止をそのまま返す',()=>{
    const stopped=new MathInputProblem('budget','利用者による中止');
    for(const kind of ['Y','K'] as const)for(const input of [{lower:128,upper:128},{lower:127,upper:128}]) {
      let calls=0;
      expect(()=>secondBesselRanges(kind,128,input,()=>{if(++calls===12)throw stopped;})).toThrow(stopped);
      expect(calls).toBe(12);
    }
  });
});
