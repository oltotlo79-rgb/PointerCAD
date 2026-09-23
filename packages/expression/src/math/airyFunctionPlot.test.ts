import Decimal from 'decimal.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { AIRY_REFERENCES } from './airyReferences.js';
import type { MathInterval } from './mathInterval.js';
import { exactDouble } from './exactDoubleInterval.js';

const D=Decimal.clone({precision:310});
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function tape(source:string) {
  return compileFunctionScalar(createFunctionMathSource(source,'text','radian',{axes:['X'],parameters:[],coefficients:[]},backend),['X'],[],{backend,shouldStop:()=>undefined});
}
function contains(range:MathInterval|null,expected:Decimal.Value) {
  if(range===null)throw new Error('Missing enclosure');
  const precise=(value:number)=>{const x=exactDouble(value);if(x===null)throw new Error('Finite range required');return new D(x.numerator.toString()).div(x.denominator.toString());};
  expect(precise(range.lower).lte(expected)).toBe(true);expect(precise(range.upper).gte(expected)).toBe(true);
}
function close(actual:number,expected:Decimal.Value) {
  const value=new D(expected);if(value.isZero())expect(actual).toBe(0);else expect(Math.abs(actual/value.toNumber()-1)).toBeLessThan(1e-12);
}
describe('Airyの作図を値・微分・範囲と元の穴まで接続する',()=>{
  it.each(AIRY_REFERENCES.filter(([,x])=>['-32','-1','0','1','32'].includes(x)))(
    '%s(%s)を値・傾き・曲がり方へ渡す',(kind,x,y,dy)=>{
      for(const prime of [false,true]) {
        const compiled=tape(`airy${kind.toLowerCase()}${prime?'prime':''}(X)`),input={lower:Number(x),upper:Number(x)};
        const value=prime?dy:y,first=prime?new D(x).mul(y):new D(dy),second=prime?new D(y).add(new D(x).mul(dy)):new D(x).mul(y);
        close(createScalarSampler(compiled)([Number(x)]),value);
        const differential=createScalarDifferential(compiled)([Number(x)]);expect(differential.reason).toBeNull();close(differential.gradient?.[0]??NaN,first);
        const range=createScalarIntervalSampler(compiled)([input]);expect(range.continuous).toBe(true);expect(range.ranges).toHaveLength(1);contains(range.ranges[0],value);
        const jet=createScalarDirectionalJet(compiled,[1])([input]);contains(jet.first,first);contains(jet.second,second);
      }
    });
  it.each(['ai','bi'])('%sの四階までの微分と合成でも方程式が同じ',kind=>{
    const row=AIRY_REFERENCES.find(([family,x])=>family.toLowerCase()===kind&&x==='1');if(row===undefined)throw new Error('Missing reference');
    const y=new D(row[2]),dy=new D(row[3]);
    for(const [index,expected] of [dy,y,y.add(dy),dy.mul(2).add(y)].entries()) {
      close(createScalarSampler(tape(`diff(airy${kind}(X),${Array.from({length:index+1},()=>'X').join(',')})`))([1]),expected);
    }
    close(createScalarSampler(tape(`diff(airy${kind}(2*X),X)`))([0.5]),dy.mul(2));
    close(createScalarSampler(tape(`diff(airy${kind}(X),X,X)`))([0]),0);
  });
  it.each(['airyai(1/X)','0*airybi(1/X)','airyaiprime(1/X)/airyaiprime(1/X)','diff(airyai(1/X),X)','diff(0*airybi(1/X),X)'])(
    '%sの元の穴を式の整理で消さない',source=>{
      const compiled=tape(source);expect(Number.isFinite(createScalarSampler(compiled)([0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{lower:-0.1,upper:0.1}]).continuous).toBe(false);
    });
});
