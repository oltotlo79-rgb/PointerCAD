import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { AIRY_REFERENCES } from './airyReferences.js';
import { airyRanges, airySample, airySlope } from './airyIntervals.js';
import { exactDouble } from './exactDoubleInterval.js';
import { nextFloat, type MathInterval } from './mathInterval.js';

const D=Decimal.clone({precision:310});
function contains(range:MathInterval|null,expected:Decimal.Value) {
  if(range===null)throw new Error('Missing Airy enclosure');
  const precise=(value:number)=>{const x=exactDouble(value);if(x===null)throw new Error('Finite range required');return new D(x.numerator.toString()).div(x.denominator.toString());};
  expect(precise(range.lower).lte(expected),JSON.stringify(range)+' below '+String(expected)).toBe(true);
  expect(precise(range.upper).gte(expected),JSON.stringify(range)+' above '+String(expected)).toBe(true);
}
const dyadic=AIRY_REFERENCES.filter(([,x])=>['-32','-24','-16','-10','-5','-1','0','0.5','1','2','8','16','24','32'].includes(x));
describe('Airyの値と傾きを振動する範囲全体で囲む',()=>{
  it.each(dyadic)('%s(%s)の値・一階・二階・三階を独立値と方程式で照合する',(kind,x,y,dy)=>{
    const input={lower:Number(x),upper:Number(x)},plain=airyRanges(kind,false,input),prime=airyRanges(kind,true,input);
    contains(plain.value,y);contains(plain.first,dy);contains(plain.second,new D(x).mul(y));
    contains(prime.value,dy);contains(prime.first,new D(x).mul(y));contains(prime.second,new D(y).add(new D(x).mul(dy)));
    expect(Math.abs(airySample(kind,false,Number(x))/Number(y)-1)).toBeLessThan(1e-14);
    expect(Math.abs(airySlope(kind,false,Number(x))/Number(dy)-1)).toBeLessThan(1e-14);
  });
  it.each([[-32,0],[-32,-16],[-10,-1],[-5,8],[0,32],[2,24]])(
    '%sから%sの途中の山・谷・原点を落とさない',(lower,upper)=>{
      for(const kind of ['Ai','Bi'] as const)for(const prime of [false,true]) {
        const result=airyRanges(kind,prime,{lower,upper});
        for(const [,x,y,dy] of AIRY_REFERENCES.filter(([family,x])=>family===kind&&Number(x)>=lower&&Number(x)<=upper)) {
          contains(result.value,prime?dy:y);
          contains(result.first,prime?new D(x).mul(y):dy);
          contains(result.second,prime?new D(y).add(new D(x).mul(dy)):new D(x).mul(y));
        }
      }
    });
  it('負側の幅を狭めた時も外向きの幅を保ち、原点の二階微分を厳密な0にする',()=>{
    for(const kind of ['Ai','Bi'] as const) {
      const row=AIRY_REFERENCES.find(([k,x])=>k===kind&&x==='-1');if(row===undefined)throw new Error('Missing reference');
      const ranges=airyRanges(kind,false,{lower:nextFloat(-1,-1),upper:nextFloat(-1,1)});
      contains(ranges.value,row[2]);contains(ranges.first,row[3]);
      expect((ranges.value?.upper??Infinity)-(ranges.value?.lower??-Infinity)).toBeLessThan(1e-14);
      expect(airySlope(kind,true,0)).toBe(0);
    }
  });
  it('作業範囲を越す入力を途中の範囲として返さない',()=>{
    for(const input of [{lower:-33,upper:0},{lower:0,upper:nextFloat(32,1)},{lower:1,upper:0},{lower:NaN,upper:0},{lower:0,upper:Infinity}]) {
      expect(airyRanges('Ai',false,input)).toEqual({value:null,first:null,second:null});
    }
  });
});
