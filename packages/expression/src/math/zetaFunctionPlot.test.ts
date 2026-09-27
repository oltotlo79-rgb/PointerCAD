import { beforeAll,describe,expect,it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarDirectionalJet } from './scalarCurveCurvature.js';
import { createScalarDifferential } from './scalarDifferential.js';
import { ZETA_DERIVATIVE_REFERENCES } from './zetaDerivativeReferences.js';
let backend:MathExecutionBackend;
beforeAll(()=>{backend=createMathBackend();});
function tape(source:string) {
  return compileFunctionScalar(createFunctionMathSource(source,'text','radian',
    {axes:['X'],parameters:[],coefficients:[]},backend),['X'],[],{backend,shouldStop:()=>undefined});
}
describe('ゼータ関数の作図で元の式・微分・発散を保つ',()=>{
  it.each(ZETA_DERIVATIVE_REFERENCES)('引数%sで値・接線・曲がり方を照合する',(source,refs)=>{
    const x=Number(source),compiled=tape('zeta(X)'),sample=createScalarSampler(compiled)([x]);
    expect(sample).toBeCloseTo(Number(refs[0]),9);
    expect(createScalarDifferential(compiled)([x]).gradient?.[0]).toBeCloseTo(Number(refs[1]),9);
    const jet=createScalarDirectionalJet(compiled,[1])([{lower:x,upper:x}]);
    for(const [actual,expected] of [[jet.first,Number(refs[1])],[jet.second,Number(refs[2])]] as const) {
      if(actual===null)throw new Error('Missing zeta derivative');
      expect(actual.lower).toBeLessThanOrEqual(expected);expect(actual.upper).toBeGreaterThanOrEqual(expected);
    }
  });
  it('15階の元の式を保存し、その値と追加二階まで確認する',()=>{
    const source=`diff(zeta(X),${Array<string>(15).fill('X').join(',')})`;
    const saved=createFunctionMathSource(source,'text','radian',{axes:['X'],parameters:[],coefficients:[]},backend);
    const original=JSON.stringify(saved),compiled=compileFunctionScalar(JSON.parse(original),['X'],[],{backend,shouldStop:()=>undefined});
    const refs=ZETA_DERIVATIVE_REFERENCES.find(([x,values])=>x==='4'&&values.length===18)?.[1];
    if(refs===undefined)throw new Error('Missing independent high derivatives');
    expect(createScalarSampler(compiled)([4])/Number(refs[15])).toBeCloseTo(1,10);
    const jet=createScalarDirectionalJet(compiled,[1])([{lower:4,upper:4}]);
    for(const [range,order] of [[jet.first,16],[jet.second,17]] as const) {
      if(range===null)throw new Error('Missing high derivative');
      expect(range.lower).toBeLessThanOrEqual(Number(refs[order]));expect(range.upper).toBeGreaterThanOrEqual(Number(refs[order]));
    }
    expect(JSON.stringify(saved)).toBe(original);expect(original).not.toContain('zeta-derivative');
  });
  it('内側の式の一階二階を掛け合わせる',()=>{
    const compiled=tape('zeta(2+X^2)'),ref=ZETA_DERIVATIVE_REFERENCES.find(([x])=>x==='2')?.[1];
    if(ref===undefined)throw new Error('Missing independent slope');
    const jet=createScalarDirectionalJet(compiled,[1])([{lower:0,upper:0}]);
    expect(jet.first?.lower).toBeLessThanOrEqual(0);expect(jet.first?.upper).toBeGreaterThanOrEqual(0);
    expect(jet.second?.lower).toBeLessThanOrEqual(2*Number(ref[1]));expect(jet.second?.upper).toBeGreaterThanOrEqual(2*Number(ref[1]));
  });
  it.each(['zeta(X)','0*zeta(X)','diff(0*zeta(X),X)','0*diff(zeta(X),X,X)'])('%sは発散点を線でつながない',source=>{
    const compiled=tape(source);
    expect(Number.isFinite(createScalarSampler(compiled)([1]))).toBe(false);
    expect(createScalarIntervalSampler(compiled)([{lower:.9,upper:1.1}]).continuous).toBe(false);
  });
});
