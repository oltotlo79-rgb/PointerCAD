import {beforeAll,describe,expect,it} from 'vitest';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionPointContinuationWork,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';
import {CANDIDATE_MATH_BY_ID,decodeMathWorkReply} from '@pointercad/expression/math/contracts';
import {createEmptyPartDocument} from '../part/createPartDocument.js';
import {evaluateDocumentMath,type DocumentMathContext} from '../part/evaluateDocumentMath.js';
import type {PartDocument} from '../part/types.js';
import {createPointFeature} from '../sketch/createSketchDocument.js';
import {FREE_WORK_PLANE_ID} from '../sketch/planeMath.js';
import type {SketchFunctionCurveFeature} from '../sketch/types.js';
import {FUNCTION_DEFINITION_FORMAT} from './functionDefinitionTypes.js';
import {POINT_DEADLINE_MESSAGE,recomputeFunctionPoints} from './recomputeFunctionPoints.js';
import type {FunctionRecomputeContext} from './recomputeFunctionCurves.js';
import {readFunctionPointChoice,type FunctionPointReference} from './functionPointReference.js';

let backend:MathExecutionBackend;beforeAll(()=>{backend=createMathBackend();});
/** A point on the circle X^2+Y^2=r^2 chosen at X=0 on the positive Y branch. */
function fixture():PartDocument {
  const document=createEmptyPartDocument(),sketch=document.sketches[0];
  const expression=createFunctionMathSource('X^2+Y^2-coef("r")^2','text','radian',
    {axes:['X','Y'],parameters:[],coefficients:[{id:'coefficient:1',label:'r'}]},backend);
  const curve:SketchFunctionCurveFeature={id:'curve',kind:'functionCurve',name:'circle',planeId:FREE_WORK_PLANE_ID,construction:false,
    definition:{format:FUNCTION_DEFINITION_FORMAT,bounds:{X:{min:number(-4),max:number(4)},Y:{min:number(-4),max:number(4)},Z:{min:number(-4),max:number(4)}},
      tolerance:number(1e-6),formula:{kind:'implicit-curve',expression,fixedAxis:'Z',fixedCoordinate:number(0)}}};
  const reference:FunctionPointReference={kind:'functionPoint',parent:{kind:'curve',sketchId:sketch.id,featureId:curve.id},
    known:[{axis:'X',value:{source:'0',display:'0',value:0}}],choice:readFunctionPointChoice({input:{expression,
      minimum:[-4,-4,-4],maximum:[4,4,4],tolerance:1e-6,coefficients:[{id:'coefficient:1',label:'r',decimal:'1'}],
      known:[{axis:'X',value:0}],fixed:{axis:'Z',value:0}},location:{kind:'implicit',axis:'Y',interval:{lower:1,upper:1}}})};
  const point={...createPointFeature(sketch,{mode:'relative',base:reference,dx:number(0),dy:number(0),dz:number(0)}),id:'chosen',planeId:FREE_WORK_PLANE_ID};
  return {...document,parameters:[{name:'r',mathId:'coefficient:1',unit:'none',description:'',value:number(2)}],
    sketches:[{...sketch,features:[curve,point]}]};
}
function math(document:PartDocument):DocumentMathContext {
  return {identity:{documentId:document.id,documentVersion:1},isCurrent:()=>true,client:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
    result:decodeMathWorkReply(executeMathWorkRequest({kind:'evaluate-math',serial:1,request},backend),request,
      {operationsById:CANDIDATE_MATH_BY_ID,coefficientIds:new Set(request.coefficients.map(item=>item.id)),declaredIds:new Set()}).result})}};
}
const noCurves:FunctionRecomputeContext['curves']={evaluate:()=>{throw new Error('Point recalculation must not sample parent curves');}};
const working:FunctionRecomputeContext={curves:noCurves,points:{evaluate:request=>Promise.resolve({status:'result',identity:request.identity,
  result:executeFunctionPointContinuationWork({kind:'continue-function-point',serial:1,request},backend).result})}};
type Ending={readonly status:'stopped';readonly reason:'deadline'|'budget'}|'deadline';
function stopped(ending:Ending):FunctionRecomputeContext {
  return {curves:noCurves,points:{evaluate:request=>Promise.resolve(ending==='deadline'?{status:'deadline',identity:request.identity}
    :{status:'result',identity:request.identity,result:ending})}};
}
async function recompute(input:PartDocument,context:FunctionRecomputeContext) {
  const evaluation=math(input),evaluated=await evaluateDocumentMath(input,evaluation);
  if(!evaluated.ok) throw new Error(JSON.stringify(evaluated));
  const result=await recomputeFunctionPoints(evaluated.document,evaluated.analysis,evaluation,context,new Map(),()=>false);
  const point=evaluated.document.sketches[0].features.find(item=>item.id==='chosen');
  if(point?.kind!=='point' || point.at.mode==='absolute' || point.at.base.kind!=='functionPoint') throw new Error('Missing point');
  return {...result,point:result.resolve(point.at.base,point.id)};
}

describe('文書の再計算で時間で止まった関数上の点を壊れた点として扱わない',()=>{
  it('時計が止まっていなければ、選んだ枝が親の現在の半径へ追従する（基準）',async()=>{
    const result=await recompute(fixture(),working);
    expect([...result.invalidInputs]).toEqual([]);expect(result.point).toEqual([0,2,0]);
  });

  it.each([{status:'stopped',reason:'deadline'} as const,'deadline' as const])(
    '追従が時間で止まる（%o）と、候補の選び直しや範囲の確認ではなく計算し直しを案内し、保存した選択を変えない',async ending=>{
      const input=fixture(),before=JSON.stringify(input);
      const result=await recompute(input,stopped(ending));
      expect(result.cancelled).toBe(false);expect(result.point).toBeNull();
      expect([...result.invalidInputs]).toEqual([['chosen',POINT_DEADLINE_MESSAGE]]);
      expect(POINT_DEADLINE_MESSAGE).not.toMatch(/選び直|範囲|精度/u);
      expect(JSON.stringify(input)).toBe(before);
      // The same document calculates the same choice again on the next recomputation.
      const again=await recompute(input,working);
      expect([...again.invalidInputs]).toEqual([]);expect(again.point).toEqual([0,2,0]);
    });

  it('計算量の停止は、これまでどおり候補の選び直しを案内する',async()=>{
    const result=await recompute(fixture(),stopped({status:'stopped',reason:'budget'}));
    expect([...result.invalidInputs]).toEqual([['chosen','選択した関数上の点の追従を確認できません。候補を選び直してください。']]);
  });
});
