/** Resolve each selected branch against the current parent before any sketch consumes it. */
import {savePointCalculationInput,decodePointContinuationRequest} from '@pointercad/expression/math/contracts';
import type {ParameterAnalysis} from '../parameters/types.js';
import {evaluatedDocumentMathValue,type DocumentMathContext} from '../part/evaluateDocumentMath.js';
import type {PartDocument} from '../part/types.js';
import {collectFunctionPointReferences} from './collectFunctionPointReferences.js';
import type {Vec3} from '../sketch/vec3.js';
import {functionPointReferenceKey,type FunctionPointReference,type FunctionPointResolver} from './functionPointReference.js';
import {functionPointRequest} from './functionPointRequest.js';
import {resolveFunctionInputs} from './resolveFunctionInputs.js';
import type {FunctionRecomputeContext} from './recomputeFunctionCurves.js';
import {functionDirectionSource} from './functionDirectionSource.js';

export async function recomputeFunctionPoints(document:PartDocument,analysis:ParameterAnalysis|undefined,
  math:DocumentMathContext|undefined,context:FunctionRecomputeContext|undefined,
  previousInvalid:ReadonlyMap<string,string>,shouldCancel:()=>boolean) {
  const points=new Map<string,Vec3>(),invalidInputs=new Map(previousInvalid);
  const current=()=>!shouldCancel() && !math?.signal?.aborted && (math?.isCurrent()??true);
  const key=(reference:FunctionPointReference,owner:string)=>JSON.stringify([owner,functionPointReferenceKey(reference)]);
  const result=(cancelled:boolean)=>({cancelled,invalidInputs,
    resolve:((reference,owner)=>cancelled || invalidInputs.has(owner)?null:points.get(key(reference,owner))??null) satisfies FunctionPointResolver});
  let inputRevision=0;
  for(const {ownerId,reference,sketch,solidIndex} of collectFunctionPointReferences(document)) {
    if(!current()) return result(true);
    if(invalidInputs.has(ownerId)) continue;
    if(points.has(key(reference,ownerId))) continue;
    try {
      if(math===undefined || context?.points===undefined || analysis===undefined) throw new Error('関数上の点の計算部を準備できません。再計算してください。');
      const selected=functionDirectionSource(document,reference,ownerId,sketch,invalidInputs);
      const parent=selected.parent;
      const parentSketch=parent.kind==='curve'?document.sketches.find(item=>item.id===parent.sketchId):undefined;
      const source=parent.kind==='surface'?document.solids.find(item=>item.id===parent.featureId):parentSketch?.features.find(item=>item.id===parent.featureId);
      if(source===undefined || (source.kind!=='functionCurve' && source.kind!=='functionSurface')
        || (parent.kind==='surface')!==(source.kind==='functionSurface')
        || (source.kind==='functionSurface' && source.suppressed) || invalidInputs.has(source.id)) throw new Error('点が参照する関数を再計算できません。');
      if(sketch!==undefined && parentSketch?.id===sketch.id
        && parentSketch.features.findIndex(item=>item.id===source.id)>=sketch.index) throw new Error('点より前に作成した関数を選んでください。');
      if(solidIndex!==undefined && parent.kind==='surface'
        && document.solids.findIndex(item=>item.id===source.id)>=solidIndex) throw new Error('この操作より前に作成した関数を選んでください。');
      const inputs=await resolveFunctionInputs(document,source.definition,analysis,current);
      if(inputs.status==='cancelled') return result(true);
      const known=selected.known.map(item=>{
        const value=evaluatedDocumentMathValue(document,item.value);
        if(value===null || !Number.isFinite(value.value)) throw new Error('指定した座標の原式を再計算できません。');
        return {axis:item.axis,value:value.value};
      });
      const request=functionPointRequest(source.definition.formula,inputs.ranges,known,{coefficients:inputs.coefficients,
        identity:{...math.identity,editorId:'document-function-point',inputRevision:++inputRevision}});
      const saved=savePointCalculationInput(request);
      const length=reference.direction?evaluatedDocumentMathValue(document,reference.direction.length):undefined;
      if(reference.direction&&(length===null||length===undefined||!Number.isFinite(length.value)||length.value<=0))throw new Error('接線・法線の長さは正の値を指定してください。');
      const direction=reference.direction&&length?{kind:reference.direction.kind,length:length.value,reverse:reference.direction.reverse}:undefined;
      const continuation=decodePointContinuationRequest({identity:request.identity,previous:selected.choice.input,current:saved,anchor:selected.choice.location,...(direction?{direction}:{})});
      const completion=await context.points.evaluate(continuation,5_000,math.signal);
      if(!current() || completion.status==='cancelled') return result(true);
      if(completion.status!=='result') throw new Error('関数上の点を計算しきれませんでした。範囲と指定座標を確認してください。');
      if(completion.result.status!=='ready') throw new Error(completion.result.status==='invalid'?completion.result.message:'選択した関数上の点の追従を確認できません。候補を選び直してください。');
      if(direction&&!completion.result.endpoint)throw new Error('接線・法線の終点を確認できません。');
      points.set(key(reference,ownerId),completion.result.endpoint?.point??completion.result.candidate.point);
    } catch(error) {
      if(!current()) return result(true);
      invalidInputs.set(ownerId,error instanceof Error?error.message:'関数上の点を再計算できませんでした。');
    }
  }
  return result(false);
}
