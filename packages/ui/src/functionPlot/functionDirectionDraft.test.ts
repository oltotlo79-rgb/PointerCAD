import {beforeAll,describe,expect,it,vi} from 'vitest';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import {createEmptyPartDocument,createFunctionCurve,createFunctionSurface,appendSolid,replaceSketch,FUNCTION_DEFINITION_FORMAT,type FunctionDefinition} from '@pointercad/model';
import {createMathBackend,createFunctionMathSource,executeMathWorkRequest,executeCurvePointWorkRequest,
  executeCurvePointContinuationWork,executeSurfacePointWorkRequest,executeSurfacePointContinuationWork,type MathExecutionBackend} from '@pointercad/expression/math/worker';
import {CANDIDATE_MATH_BY_ID,decodeMathWorkReply,isCurvePointInput,isCurvePointContinuation,isSurfacePointInput,isSurfacePointContinuation} from '@pointercad/expression/math/contracts';
import type {MathWorkerClient,PointCalculationWorkerClient,PointContinuationWorkerClient} from '@pointercad/expression/math/client';
import {searchFunctionPoints,applyFunctionPointChoice} from './functionPointDraft.js';
import {evaluateFunctionDirection} from './functionDirectionDraft.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
const client:Pick<MathWorkerClient,'evaluate'>={evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
  result:decodeMathWorkReply(executeMathWorkRequest({kind:'evaluate-math',serial:1,request},backend),request,
    {operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(request.coefficients.map(item=>item.id)),declaredIds:new Set()}).result})};
const points:Pick<PointCalculationWorkerClient,'evaluate'>={evaluate:request=>{
  if(isSurfacePointInput(request))return Promise.resolve({status:'result',identity:request.identity,result:executeSurfacePointWorkRequest({kind:'solve-surface-points',serial:1,request},backend).result});
  if(!isCurvePointInput(request))throw new Error('Expected curve');
  return Promise.resolve({status:'result',identity:request.identity,result:executeCurvePointWorkRequest({kind:'solve-curve-points',serial:1,request},backend).result});
}};
const continuation:Pick<PointContinuationWorkerClient,'evaluate'>={evaluate:request=>{
  if(isSurfacePointContinuation(request))return Promise.resolve({status:'result',identity:request.identity,result:executeSurfacePointContinuationWork({kind:'continue-surface-point',serial:1,request},backend).result});
  if(!isCurvePointContinuation(request))throw new Error('Expected curve continuation');
  return Promise.resolve({status:'result',identity:request.identity,result:executeCurvePointContinuationWork({kind:'continue-curve-point',serial:1,request},backend).result});
}};
async function fixture(y='T^2'){
  const base=createEmptyPartDocument(),sketch=base.sketches[0];
  const formula=(source:string)=>createFunctionMathSource(source,'text','degree',{axes:[],parameters:['T'],coefficients:[]},backend);
  const definition:FunctionDefinition={format:FUNCTION_DEFINITION_FORMAT,tolerance:number(1e-7),
    bounds:{X:{min:number(-2),max:number(2)},Y:{min:number(-2),max:number(2)},Z:{min:number(-2),max:number(2)}},
    formula:{kind:'parametric-curve',T:{min:number(-2),max:number(2)},outputs:{X:formula('T'),Y:formula(y),Z:formula('0')}}};
  const curve=createFunctionCurve(sketch,definition),document=replaceSketch(base,{...sketch,features:[curve]});
  const result=await searchFunctionPoints(document,1,{kind:'curve',sketchId:sketch.id,featureId:curve.id},
    {X:{source:'0',angleUnit:'degree'},Y:null,Z:null},client,points,new AbortController().signal,()=>true);
  if(result.status!=='ready'||result.search.candidates.length!==1)throw new Error(JSON.stringify(result));
  const input=applyFunctionPointChoice(result.search,result.search.candidates[0]),point=input.sketches[0].features.at(-1);
  if(point?.kind!=='point')throw new Error('Missing point');return {input,point};
}
describe('接線・法線を点に従う1本の線分として作る',()=>{
  it.each(['normal','tangent-u','tangent-v']as const)('媒介曲面では%sを世界座標へ正規化して保存する',async kind=>{
    const base=createEmptyPartDocument(),formula=(source:string)=>createFunctionMathSource(source,'text','degree',{axes:[],parameters:['U','V'],coefficients:[]},backend);
    const range={min:number(-2),max:number(2)},definition:FunctionDefinition={format:FUNCTION_DEFINITION_FORMAT,tolerance:number(1e-7),bounds:{X:range,Y:range,Z:range},
      formula:{kind:'parametric-surface',U:range,V:range,outputs:{X:formula('U'),Y:formula('V'),Z:formula('U^2+V^2')}}};
    const feature=createFunctionSurface(base,definition),document=appendSolid(base,feature),signal=new AbortController().signal;
    const search=await searchFunctionPoints(document,1,{kind:'surface',featureId:feature.id},
      {X:{source:'0',angleUnit:'degree'},Y:{source:'0',angleUnit:'degree'},Z:null},client,points,signal,()=>true);
    if(search.status!=='ready'||search.search.candidates.length!==1)throw new Error(JSON.stringify(search));
    const prepared=applyFunctionPointChoice(search.search,search.search.candidates[0]),point=prepared.sketches[0].features.at(-1);
    if(point?.kind!=='point')throw new Error('Missing surface point');
    const result=await evaluateFunctionDirection(prepared,1,point.id,kind,{source:'5',angleUnit:'degree'},false,client,points,continuation,signal,()=>true);
    const expected=kind==='normal'?[0,0,5]:kind==='tangent-u'?[5,0,0]:[0,5,0];
    expect(result).not.toBeNull();expected.forEach((value,index)=>expect(result?.to[index]).toBeCloseTo(value,7));
    expect(result?.document.sketches[0].features.at(-1)).toMatchObject({to:{base:{direction:{kind,sourcePointId:point.id}}}});
  });
  it.each([false,true])('法線の正の長さの式と向きを保存し、元の文書を変えない（逆向き=%s）',async reverse=>{
    const {input,point}=await fixture(),before=JSON.stringify(input);
    const result=await evaluateFunctionDirection(input,1,point.id,'normal',{source:'2*5',angleUnit:'degree'},reverse,client,points,continuation,new AbortController().signal,()=>true);
    expect(result?.from).toEqual([0,0,0]);expect(result?.to[1]).toBeCloseTo(reverse?-10:10,7);
    const features=result?.document.sketches[0].features;expect(features).toHaveLength(input.sketches[0].features.length+1);
    expect(features?.at(-1)).toMatchObject({kind:'line',from:{base:{kind:'point',pointId:point.id}},
      to:{base:{kind:'functionPoint',direction:{kind:'normal',length:{source:'2*5',value:10},reverse,sourcePointId:point.id}}}});
    expect(JSON.stringify(input)).toBe(before);
  });
  it('直線部分の主法線を拒否し、接線は作成できる',async()=>{
    const {input,point}=await fixture('0'),length={source:'5',angleUnit:'degree' as const};
    await expect(evaluateFunctionDirection(input,1,point.id,'normal',length,false,client,points,continuation,new AbortController().signal,()=>true)).rejects.toThrow('一意');
    const tangent=await evaluateFunctionDirection(input,1,point.id,'tangent',length,false,client,points,continuation,new AbortController().signal,()=>true);
    expect(tangent?.to[0]).toBeCloseTo(5,7);
  });
  it('再編集は同じ線分を置き換え、保存した起点とIDを維持する',async()=>{
    const {input,point}=await fixture(),signal=new AbortController().signal;
    const created=await evaluateFunctionDirection(input,1,point.id,'tangent',{source:'5',angleUnit:'degree'},false,client,points,continuation,signal,()=>true);
    if(!created)throw new Error('Missing preview');
    const line=created.document.sketches[0].features.at(-1);if(line?.kind!=='line')throw new Error('Missing line');
    const changed=await evaluateFunctionDirection(created.document,2,point.id,'normal',{source:'2*3',angleUnit:'degree'},true,client,points,continuation,signal,()=>true,line.id);
    expect(changed?.document.sketches[0].features).toHaveLength(created.document.sketches[0].features.length);
    expect(changed?.document.sketches[0].features.at(-1)).toMatchObject({id:line.id,name:line.name,to:{base:{direction:{kind:'normal',reverse:true,length:{source:'2*3',value:6}}}}});
    expect(changed?.to[1]).toBeCloseTo(-6,7);
  });
  it.each(['0','-1','1/0'])('不正な長さ%sでは線分を作らない',async source=>{
    const {input,point}=await fixture(),before=JSON.stringify(input);
    await expect(evaluateFunctionDirection(input,1,point.id,'tangent',{source,angleUnit:'degree'},false,client,points,continuation,new AbortController().signal,()=>true)).rejects.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });
  it('中止後や文書変更後の方向返信を適用しない',async()=>{
    const {input,point}=await fixture(),abort=new AbortController();let current=true;
    const evaluate=vi.fn<PointContinuationWorkerClient['evaluate']>(async (...args)=>{
      const result=await continuation.evaluate(...args);current=false;abort.abort();return result;
    });
    const result=await evaluateFunctionDirection(input,1,point.id,'tangent',{source:'5',angleUnit:'degree'},false,client,points,{evaluate},abort.signal,()=>current);
    expect(evaluate).toHaveBeenCalledTimes(1);expect(result).toBeNull();
  });
});
