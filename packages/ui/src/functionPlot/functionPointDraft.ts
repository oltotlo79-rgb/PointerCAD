/** Point searches use the same scalar editor and finite parent bounds as function plotting. */
import {collectMathCoefficients,mathScalarExpression,type ExpressionValue} from '@pointercad/expression';
import {FunctionPlotBounds,functionPointRequest,createPointFeature,replaceSketch,FREE_WORK_PLANE_ID,readFunctionPointChoice,
  type PartDocument,type FunctionPointParent,type FunctionPointReference} from '@pointercad/model';
import {expressionValueFromNumber as number} from '@pointercad/expression';
import type {
  PointCalculationWorkerClient,
  MathWorkerClient,
} from '@pointercad/expression/math/client';

import {
  savePointCalculationInput,
  type PointCalculationCandidate,
  type PointCalculationRequest,
} from '@pointercad/expression/math/contracts';

import {prepareDocumentMathEnvironment} from '../math/prepareDocumentMathEditor.js';
import {evaluateFunctionPlotDraft,functionPlotDraft,type FunctionScalarDraft,FUNCTION_AXES} from './functionPlotDraft.js';
import {t} from '../i18n/t.js';

export type FunctionPointFields=Readonly<Record<typeof FUNCTION_AXES[number],FunctionScalarDraft|null>>;
export interface FunctionPointSearch {
  readonly document:PartDocument;readonly parent:FunctionPointParent;readonly request:PointCalculationRequest;
  readonly known:FunctionPointReference['known'];readonly candidates:readonly PointCalculationCandidate[];
  readonly exhaustive:boolean;readonly unresolved:number;
}
export type FunctionPointSearchResult={readonly status:'ready';readonly search:FunctionPointSearch}
  |{readonly status:'cancelled'}|{readonly status:'failed';readonly message:string};

export async function searchFunctionPoints(document:PartDocument,documentVersion:number,parent:FunctionPointParent,
  fields:FunctionPointFields,client:Pick<MathWorkerClient,'evaluate'>,points:Pick<PointCalculationWorkerClient,'evaluate'>,
  signal:AbortSignal,isCurrent:()=>boolean):Promise<FunctionPointSearchResult> {
  const current=()=>!signal.aborted && isCurrent();
  if(!current()) return {status:'cancelled'};
  const feature=parent.kind==='surface'?document.solids.find(item=>item.id===parent.featureId)
    :document.sketches.find(item=>item.id===parent.sketchId)?.features.find(item=>item.id===parent.featureId);
  if(!feature || (feature.kind!=='functionCurve' && feature.kind!=='functionSurface') || (feature.kind==='functionSurface' && feature.suppressed)) {
    return {status:'failed',message:t('functionPlot.missingCurve')};
  }
  const axes=FUNCTION_AXES.filter(axis=>fields[axis]!==null);
  if(axes.length<1 || axes.length>2) return {status:'failed',message:t('functionPoint.chooseCoordinates')};
  const evaluated=await evaluateFunctionPlotDraft(document,documentVersion,functionPlotDraft(feature),client,signal,current);
  if(!current() || (!evaluated.ok && evaluated.cancelled)) return {status:'cancelled'};
  if(!evaluated.ok) return {status:'failed',message:[...evaluated.fields.values()].join('\n')};
  const identity={documentId:document.id,documentVersion,editorId:'function-point-form',inputRevision:0};
  const environment=await prepareDocumentMathEnvironment(evaluated.prepared,{client,identity,signal,isCurrent:current});
  if(!current()) return {status:'cancelled'};
  const known:{axis:typeof FUNCTION_AXES[number];value:ExpressionValue}[]=[];
  for(const axis of axes) {
    const input=fields[axis];if(input===null) continue;
    if(input.source.trim()==='') return {status:'failed',message:`${axis}: ${t('functionPlot.required')}`};
    const completion=await client.evaluate({identity:{...identity,inputRevision:known.length+1},source:input.source,
      notation:input.accepted?.mathDefinition?.inputNotation??'text',angleUnit:input.angleUnit,coefficients:environment.coefficients,
      ...(input.accepted?.mathDefinition?{definition:input.accepted.mathDefinition}:{})},5_000,signal);
    if(!current() || completion.status==='cancelled') return {status:'cancelled'};
    if(completion.status!=='result') return {status:'failed',message:t('math.workerFailed')};
    const scalar=mathScalarExpression(completion.result);
    if(!scalar.ok) return {status:'failed',message:`${axis}: ${scalar.message}`};
    known.push({axis,value:scalar.value});
  }
  const {definition}=evaluated,formula=definition.formula;
  // These values were just evaluated above; no stored numeric cache supplies the search box.
  const bounds=FunctionPlotBounds.read(Object.fromEntries(FUNCTION_AXES.map(axis=>[axis,
    {min:definition.bounds[axis].min.value,max:definition.bounds[axis].max.value}])));
  if(!bounds.ok) return {status:'failed',message:t('functionPlot.invalidRange')};
  const expressions='outputs' in formula?Object.values(formula.outputs):[formula.expression];
  const used=new Set(expressions.flatMap(expression=>collectMathCoefficients(expression.expression).map(item=>item.id)));
  const parameters=formula.kind==='parametric-curve'?[{parameter:'T' as const,range:{min:formula.T.min.value,max:formula.T.max.value}}]
    :formula.kind==='parametric-surface'?(['U','V'] as const).map(parameter=>({parameter,range:{min:formula[parameter].min.value,max:formula[parameter].max.value}})):[];
  const request=functionPointRequest(formula,{bounds:bounds.bounds,tolerance:definition.tolerance.value,parameters,
    fixedCoordinate:formula.kind==='implicit-curve'?formula.fixedCoordinate.value:null},known.map(item=>({axis:item.axis,value:item.value.value})),
    {identity:{...identity,inputRevision:known.length+1},coefficients:environment.coefficients.filter(item=>used.has(item.id))});
  const completion=await points.evaluate(request,5_000,signal);
  if(!current() || completion.status==='cancelled') return {status:'cancelled'};
  if(completion.status!=='result') return {status:'failed',message:t('math.workerFailed')};
  const result=completion.result;
  if(result.status==='invalid') return {status:'failed',message:result.message};
  if(result.status==='underconstrained') return {status:'failed',message:t('functionPoint.moreCoordinates')};
  if(result.status==='out-of-range') return {status:'failed',message:t('functionPoint.outside')};
  if(result.status!=='ready') return {status:'failed',message:t('functionPoint.incomplete')};
  if(result.candidates.length===0 && result.unresolved.some(item=>item.reason==='continuum')) return {status:'failed',message:t('functionPoint.continuum')};
  return {status:'ready',search:{document:environment.prepared,parent,request,known,candidates:result.candidates,
    exhaustive:result.exhaustive,unresolved:result.unresolved.length}};
}

export function applyFunctionPointChoice(search:FunctionPointSearch,candidate:PointCalculationCandidate,pointId?:string):PartDocument {
  if(!search.exhaustive || search.unresolved!==0) throw new Error(t('functionPoint.completeRequired'));
  if(!search.candidates.includes(candidate)) throw new Error(t('functionPoint.changedChoice'));
  const {request,document,parent}=search;
  const sketch=pointId===undefined?document.sketches.find(item=>item.id===(parent.kind==='curve'?parent.sketchId:document.activeSketchId))
    :document.sketches.find(item=>item.features.some(feature=>feature.id===pointId));
  if(!sketch) throw new Error(t('functionPlot.missingCurve'));
  const previous=pointId===undefined?undefined:sketch.features.find(item=>item.id===pointId);
  if(pointId!==undefined && (previous?.kind!=='point'||previous.at.mode==='absolute'||previous.at.base.kind!=='functionPoint')) throw new Error(t('functionPoint.changedChoice'));
  const existing=previous?.kind==='point'?previous:undefined;
  const choice=readFunctionPointChoice({input:savePointCalculationInput(request),location:candidate.location});
  const base:FunctionPointReference={kind:'functionPoint',parent,known:search.known,choice,
    ...(existing?.at.mode!=='absolute'&&existing?.at.base.kind==='functionPoint'&&existing.at.base.direction?{direction:existing.at.base.direction}:{})};
  const at=existing&&existing.at.mode!=='absolute'?{...existing.at,base}:{mode:'relative' as const,base,dx:number(0),dy:number(0),dz:number(0)};
  const point={...(existing??createPointFeature(sketch,{mode:'relative',base,dx:number(0),dy:number(0),dz:number(0)})),
    kind:'point' as const,at,planeId:existing?.planeId??FREE_WORK_PLANE_ID};
  return replaceSketch(document,{...sketch,features:previous?sketch.features.map(item=>item.id===previous.id?point:item):[...sketch.features,point]});
}
