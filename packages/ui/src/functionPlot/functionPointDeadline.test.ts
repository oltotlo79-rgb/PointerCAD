import {beforeAll,describe,expect,it} from 'vitest';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import {createEmptyPartDocument,createFunctionCurve,replaceSketch,FUNCTION_DEFINITION_FORMAT,type FunctionDefinition,type PartDocument} from '@pointercad/model';
import {createMathBackend,createFunctionMathSource,executeMathWorkRequest,executeCurvePointWorkRequest,
  executeCurvePointContinuationWork,type MathExecutionBackend} from '@pointercad/expression/math/worker';
import {CANDIDATE_MATH_BY_ID,decodeMathWorkReply,isCurvePointInput,isCurvePointContinuation} from '@pointercad/expression/math/contracts';
import type {MathWorkerClient,PointCalculationWorkerClient,PointContinuationWorkerClient} from '@pointercad/expression/math/client';
import {searchFunctionPoints,applyFunctionPointChoice} from './functionPointDraft.js';
import {evaluateFunctionDirection} from './functionDirectionDraft.js';
import {t} from '../i18n/t.js';

const TIME_LIMIT='点の計算が時間内に終わりませんでした。もう一度計算してください。';
let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const client:Pick<MathWorkerClient,'evaluate'>={evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
  result:decodeMathWorkReply(executeMathWorkRequest({kind:'evaluate-math',serial:1,request},backend),request,
    {operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(request.coefficients.map(item=>item.id)),declaredIds:new Set()}).result})};
const points:Pick<PointCalculationWorkerClient,'evaluate'>={evaluate:request=>{
  if(!isCurvePointInput(request))throw new Error('Expected curve');
  return Promise.resolve({status:'result',identity:request.identity,result:executeCurvePointWorkRequest({kind:'solve-curve-points',serial:1,request},backend).result});
}};
const continuation:Pick<PointContinuationWorkerClient,'evaluate'>={evaluate:request=>{
  if(!isCurvePointContinuation(request))throw new Error('Expected curve continuation');
  return Promise.resolve({status:'result',identity:request.identity,result:executeCurvePointContinuationWork({kind:'continue-curve-point',serial:1,request},backend).result});
}};
type Stop={readonly status:'stopped';readonly reason:'deadline'|'budget'};
/** The Worker's own stop (a result) or the window's bounded client (5 seconds) ending the calculation. */
type Ending=Stop|'deadline';
function curve():{readonly document:PartDocument;readonly parent:{readonly kind:'curve';readonly sketchId:string;readonly featureId:string}} {
  const base=createEmptyPartDocument(),sketch=base.sketches[0];
  const formula=(source:string)=>createFunctionMathSource(source,'text','degree',{axes:[],parameters:['T'],coefficients:[]},backend);
  const definition:FunctionDefinition={format:FUNCTION_DEFINITION_FORMAT,tolerance:number(1e-7),
    bounds:{X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(2)}},
    formula:{kind:'parametric-curve',T:{min:number(-2),max:number(2)},outputs:{X:formula('T'),Y:formula('T^2'),Z:formula('0')}}};
  const feature=createFunctionCurve(sketch,definition);
  return {document:replaceSketch(base,{...sketch,features:[feature]}),parent:{kind:'curve',sketchId:sketch.id,featureId:feature.id}};
}
const signal=new AbortController().signal,field={source:'0',angleUnit:'degree' as const};
function stoppedSearch(ending:Ending):Pick<PointCalculationWorkerClient,'evaluate'> {
  return {evaluate:request=>Promise.resolve(ending==='deadline'?{status:'deadline',identity:request.identity}
    :{status:'result',identity:request.identity,result:ending})};
}
function stoppedContinuation(ending:Ending):Pick<PointContinuationWorkerClient,'evaluate'> {
  return {evaluate:request=>Promise.resolve(ending==='deadline'?{status:'deadline',identity:request.identity}
    :{status:'result',identity:request.identity,result:ending})};
}

describe('点の計算が時間で止まったときは、範囲や候補の見直しではなく計算し直しを案内する',()=>{
  it('時間の停止の文は i18n にあり、範囲・精度・候補の見直しを求めない',()=>{
    expect(t('functionPoint.deadline')).toBe(TIME_LIMIT);
    expect(TIME_LIMIT).not.toMatch(/範囲|精度|選び直/u);
    expect(t('functionPoint.incomplete')).toContain('範囲や精度を見直して');
  });

  it.each([{status:'stopped',reason:'deadline'} as const,'deadline' as const])('候補の探索が時間で止まる（%o）と時間の文を出す',async ending=>{
    const input=curve();
    const result=await searchFunctionPoints(input.document,1,input.parent,{X:field,Y:null,Z:null},client,stoppedSearch(ending),signal,()=>true);
    expect(result).toEqual({status:'failed',message:TIME_LIMIT});
  });

  it('候補の探索が計算量で止まったときは、これまでどおり範囲や精度の見直しを出す',async()=>{
    const input=curve();
    const result=await searchFunctionPoints(input.document,1,input.parent,{X:field,Y:null,Z:null},client,
      stoppedSearch({status:'stopped',reason:'budget'}),signal,()=>true);
    expect(result).toEqual({status:'failed',message:t('functionPoint.incomplete')});
  });

  it.each([{status:'stopped',reason:'deadline'} as const,'deadline' as const,{status:'stopped',reason:'budget'} as const])(
    '接線・法線の追従が止まる（%o）と、時間なら時間の文、計算量なら範囲や精度の見直しを出す',async ending=>{
      const input=curve();
      const found=await searchFunctionPoints(input.document,1,input.parent,{X:field,Y:null,Z:null},client,points,signal,()=>true);
      if(found.status!=='ready'||found.search.candidates.length!==1)throw new Error(JSON.stringify(found));
      const document=applyFunctionPointChoice(found.search,found.search.candidates[0]),point=document.sketches[0].features.at(-1);
      if(point?.kind!=='point')throw new Error('Missing point');
      // The real continuation finishes: only the stopped reply differs.
      await expect(evaluateFunctionDirection(document,1,point.id,'normal',{source:'2',angleUnit:'degree'},false,client,points,continuation,signal,()=>true))
        .resolves.not.toBeNull();
      const expected=ending!=='deadline'&&ending.reason==='budget'?t('functionPoint.incomplete'):TIME_LIMIT;
      await expect(evaluateFunctionDirection(document,1,point.id,'normal',{source:'2',angleUnit:'degree'},false,client,points,
        stoppedContinuation(ending),signal,()=>true)).rejects.toThrow(expected);
    });
});
