/** The preview comes from a revalidated branch; the document stores its defining references. */
import {expressionValueFromNumber as number,mathScalarExpression,type ExpressionValue} from '@pointercad/expression';
import {nextFeatureId,nextFeatureName,replaceSketch,FREE_WORK_PLANE_ID,type PartDocument,type FunctionPointReference,type SketchLineFeature} from '@pointercad/model';
import {decodePointContinuationRequest,savePointCalculationInput,type FunctionPointDirectionKind,type PointCalculationSavedInput} from '@pointercad/expression/math/contracts';
import type {MathWorkerClient,PointCalculationWorkerClient,PointContinuationWorkerClient} from '@pointercad/expression/math/client';
import {prepareDocumentMathEnvironment} from '../math/prepareDocumentMathEditor.js';
import {searchFunctionPoints,type FunctionPointFields} from './functionPointDraft.js';
import type {FunctionScalarDraft} from './functionPlotDraft.js';
import {t} from '../i18n/t.js';

export function functionDirectionKinds(input:PointCalculationSavedInput):readonly FunctionPointDirectionKind[] {
  if('kind' in input&&input.kind==='curve')return ['tangent','normal'];
  if('kind' in input&&input.kind==='parametric-surface')return ['tangent-u','tangent-v','normal'];
  return 'fixed' in input&&input.fixed?['tangent','normal']:['normal'];
}
export interface FunctionDirectionPreview {
  readonly document:PartDocument;readonly from:readonly [number,number,number];readonly to:readonly [number,number,number];
  readonly minimum:readonly [number,number,number];readonly maximum:readonly [number,number,number];
}
export async function evaluateFunctionDirection(document:PartDocument,documentVersion:number,pointId:string,
  kind:FunctionPointDirectionKind,length:FunctionScalarDraft,reverse:boolean,client:Pick<MathWorkerClient,'evaluate'>,
  points:Pick<PointCalculationWorkerClient,'evaluate'>,continuations:Pick<PointContinuationWorkerClient,'evaluate'>,
  signal:AbortSignal,isCurrent:()=>boolean,lineId?:string):Promise<FunctionDirectionPreview|null> {
  const current=()=>!signal.aborted&&isCurrent();if(!current())return null;
  const sketch=document.sketches.find(sketch=>sketch.features.some(item=>item.id===pointId)),point=sketch?.features.find(item=>item.id===pointId);
  if(!sketch||point?.kind!=='point'||point.at.mode!=='relative'||point.at.base.kind!=='functionPoint'||point.at.base.direction){
    throw new Error(t('functionDirection.choosePoint'));
  }
  const reference=point.at.base;
  if(!functionDirectionKinds(reference.choice.input).includes(kind))throw new Error(t('functionDirection.chooseKind'));
  const field=(axis:'X'|'Y'|'Z')=>{const value=reference.known.find(item=>item.axis===axis)?.value;
    return value?{source:value.source,angleUnit:value.mathDefinition?.angleUnit??'degree' as const,accepted:value}:null;};
  const fields:FunctionPointFields={X:field('X'),Y:field('Y'),Z:field('Z')};
  const found=await searchFunctionPoints(document,documentVersion,reference.parent,fields,client,points,signal,current);
  if(!current()||found.status==='cancelled')return null;
  if(found.status==='failed')throw new Error(found.message);
  if(!found.search.exhaustive||found.search.unresolved!==0)throw new Error(t('functionPoint.completeRequired'));
  const identity={documentId:document.id,documentVersion,editorId:'function-direction',inputRevision:0};
  const environment=await prepareDocumentMathEnvironment(found.search.document,{identity,client,signal,isCurrent:current});
  if(!current())return null;
  let revision=0;
  const scalar=async(input:FunctionScalarDraft):Promise<ExpressionValue|null>=>{
    const completion=await client.evaluate({identity:{...identity,inputRevision:++revision},source:input.source,
      notation:input.accepted?.mathDefinition?.inputNotation??'text',angleUnit:input.angleUnit,coefficients:environment.coefficients,
      ...(input.accepted?.mathDefinition?{definition:input.accepted.mathDefinition}:{})},5_000,signal);
    if(!current()||completion.status==='cancelled')return null;
    if(completion.status!=='result')throw new Error(t('math.workerFailed'));
    const value=mathScalarExpression(completion.result);if(!value.ok)throw new Error(value.message);return value.value;
  };
  for(const offset of [point.at.dx,point.at.dy,point.at.dz]){
    const value=await scalar({source:offset.source,angleUnit:offset.mathDefinition?.angleUnit??'degree',accepted:offset});
    if(value===null)return null;if(value.value!==0)throw new Error(t('functionDirection.offsetPoint'));
  }
  const value=await scalar(length);if(value===null)return null;
  if(value.value<=0)throw new Error(t('functionDirection.positiveLength'));
  const direction={kind,length:value.value,reverse};
  const request=decodePointContinuationRequest({identity:{...identity,inputRevision:++revision},previous:reference.choice.input,
    current:savePointCalculationInput(found.search.request),anchor:reference.choice.location,direction});
  const completion=await continuations.evaluate(request,5_000,signal);
  if(!current()||completion.status==='cancelled')return null;
  if(completion.status!=='result')throw new Error(t('math.workerFailed'));
  if(completion.result.status!=='ready')throw new Error(completion.result.status==='invalid'?completion.result.message:t('functionPoint.incomplete'));
  const endpoint=completion.result.endpoint;if(!endpoint)throw new Error(t('functionDirection.unresolved'));
  const prepared=environment.prepared,owner=prepared.sketches.find(item=>item.id===sketch.id);if(!owner)throw new Error(t('functionDirection.choosePoint'));
  const previous=lineId===undefined?undefined:owner.features.find(item=>item.id===lineId);
  if(lineId!==undefined&&(previous?.kind!=='line'||previous.to.mode!=='relative'||previous.to.base.kind!=='functionPoint'
    ||previous.to.base.direction?.sourcePointId!==pointId))throw new Error(t('functionDirection.changedLine'));
  const base:FunctionPointReference={...reference,direction:{kind,length:value,reverse,sourcePointId:pointId}};
  const line:SketchLineFeature={...(previous?.kind==='line'?previous:{}),id:previous?.id??nextFeatureId(owner,'line'),name:previous?.name??nextFeatureName(owner,'line'),kind:'line',planeId:FREE_WORK_PLANE_ID,construction:previous?.kind==='line'?previous.construction:false,
    from:{mode:'relative',base:{kind:'point',pointId},dx:number(0),dy:number(0),dz:number(0)},
    to:{mode:'relative',base,dx:number(0),dy:number(0),dz:number(0)}};
  const minimum=found.search.request.minimum.map((value,axis)=>Math.min(value,endpoint.minimum[axis]));
  const maximum=found.search.request.maximum.map((value,axis)=>Math.max(value,endpoint.maximum[axis]));
  return {document:replaceSketch(prepared,{...owner,features:previous?owner.features.map(item=>item.id===previous.id?line:item):[...owner.features,line]}),
    from:completion.result.candidate.point,to:endpoint.point,minimum:[minimum[0],minimum[1],minimum[2]],maximum:[maximum[0],maximum[1],maximum[2]]};
}
