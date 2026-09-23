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
import { LAMBERT_W_DERIVATIVES } from './lambertWDerivativeReferences.js';
import { lambertWValueRange } from './lambertWIntervals.js';
import type { MathInterval } from './mathInterval.js';
import { exactDouble } from './exactDoubleInterval.js';

const D=Decimal.clone({precision:150});
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function tape(source:string) {
  return compileFunctionScalar(createFunctionMathSource(source,'text','radian',
    {axes:['X'],parameters:[],coefficients:[]},backend),['X'],[],{backend,shouldStop:()=>undefined});
}
function contains(range:MathInterval|null,expected:string):void {
  expect(range).not.toBeNull();if(range===null)throw new Error('Missing enclosure');
  const exact=(value:number)=>{
    const rational=exactDouble(value);if(rational===null)throw new Error('Non-finite enclosure');
    return new D(rational.numerator.toString()).div(rational.denominator.toString());
  };
  expect(exact(range.lower).lte(expected)).toBe(true);expect(exact(range.upper).gte(expected)).toBe(true);
}
function close(actual:number,expected:string):void {
  if(new D(expected).isZero())expect(actual).toBe(0);
  else expect(Math.abs(actual/Number(expected)-1)).toBeLessThan(5e-12);
}

describe('Lambert Wの枝を値・微分・範囲・元の穴の全経路で保持する',()=>{
  it.each(LAMBERT_W_DERIVATIVES)('枝%s・入力%sの値と一階二階微分を独立基準へ照合する',(branch,x,v,d1,d2)=>{
    const compiled=tape(`lambertw(${branch},X)`),input=Number(x);
    close(createScalarSampler(compiled)([input]),v);
    const differential=createScalarDifferential(compiled)([input]);
    expect(differential.reason).toBeNull();close(differential.gradient?.[0]??NaN,d1);
    const interval={lower:input,upper:input},range=createScalarIntervalSampler(compiled)([interval]);
    expect(range.continuous).toBe(true);expect(range.ranges).toHaveLength(1);contains(range.ranges[0],v);
    const jet=createScalarDirectionalJet(compiled,[1])([interval]);contains(jet.first,d1);contains(jet.second,d2);
  });
  it.each([0,-1] as const)('枝%sの四階までの式の微分と合成を保つ',branch=>{
    const reference=LAMBERT_W_DERIVATIVES.find(([b,x])=>b===branch&&x==='-0.125');
    if(reference===undefined)throw new Error('Missing reference');
    const [,,,d1,d2,d3,d4]=reference;
    for(const [index,expected] of [d1,d2,d3,d4].entries()) {
      close(createScalarSampler(tape(`diff(lambertw(${branch},X),${Array.from({length:index+1},()=>'X').join(',')})`))([-0.125]),expected);
    }
    close(createScalarSampler(tape(`diff(lambertw(${branch},2*X),X)`))([-0.0625]),new D(reference[3]).mul(2).toString());
    const constant=createScalarIntervalSampler(tape(`lambertw(${branch},-0.125)+X`))([{lower:0,upper:0}]);
    expect(constant.continuous).toBe(true);contains(constant.ranges[0],reference[2]);
  });
  it('主枝の原点の微分を0割りにせず、二つの枝の単調性を保つ',()=>{
    for(const [order,expected] of [[1,1],[2,-2],[3,9],[4,-64]]) {
      expect(createScalarSampler(tape(`diff(lambertw(0,X),${Array.from({length:order},()=>'X').join(',')})`))([0])).toBe(expected);
    }
    for(const branch of [0,-1] as const) {
      const range=lambertWValueRange(branch,{lower:-0.25,upper:-0.0625});
      for(const [,x,v] of LAMBERT_W_DERIVATIVES.filter(([b,x])=>b===branch&&Number(x)>=-0.25&&Number(x)<=-0.0625)) {
        contains(range,v);expect(Number(x)).toBeLessThan(0);
      }
    }
  });
  it.each(['lambertw(-1,X)','0*lambertw(-1,X)','lambertw(-1,X)/lambertw(-1,X)',
    'diff(0*lambertw(-1,X),X)','lambertw(0,1/X)','diff(lambertw(0,1/X),X)'])(
    '%sの元の穴を0倍・約分・微分で消さない',source=>{
      const compiled=tape(source);
      expect(Number.isFinite(createScalarSampler(compiled)([0]))).toBe(false);
      expect(createScalarIntervalSampler(compiled)([{lower:-0.1,upper:0.1}]).continuous).toBe(false);
    });
  it('実数領域の境界をまたいで接続せず、枝を変数にしない',()=>{
    for(const branch of [0,-1]) {
      const compiled=tape(`lambertw(${branch},X)`);
      expect(Number.isNaN(createScalarSampler(compiled)([-0.38]))).toBe(true);
      expect(createScalarIntervalSampler(compiled)([{lower:-0.38,upper:-0.36}]).continuous).toBe(false);
      expect(createScalarDifferential(compiled)([-0.38]).gradient).toBeNull();
    }
    expect(()=>tape('lambertw(X,1)')).toThrow('枝');
    expect(()=>tape('lambertw(1,X)')).toThrow('枝');
  });
});
