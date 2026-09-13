import { MAX_FUNCTION_SURFACE_FACES, MAX_FUNCTION_SURFACE_VERTICES, FUNCTION_CLIP_BOUND_TOLERANCE } from '@pointercad/kernel';
import {
  decodeFunctionImplicitWorkRequest,
  FUNCTION_SURFACE_LIMITS,
} from '@pointercad/expression/math/contracts';

import type { FunctionImplicitWorkerClient } from '@pointercad/expression/math/client';
import type { FunctionFormula } from './functionDefinitionTypes.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';
import type { FunctionRequestContext } from './functionRequestInputs.js';
import type { FunctionSurfacePlan } from './functionSurfaceFeature.js';

export async function recomputeImplicitFunctionSurface(formula:Extract<FunctionFormula,{kind:'implicit-surface'}>,ranges:ResolvedFunctionRanges,
  context:FunctionRequestContext,client:Pick<FunctionImplicitWorkerClient,'evaluate'>,signal:AbortSignal|undefined,
  isCurrent:()=>boolean):Promise<FunctionSurfacePlan|null> {
  const X=ranges.bounds.interval('X'),Y=ranges.bounds.interval('Y'),Z=ranges.bounds.interval('Z');
  const request=decodeFunctionImplicitWorkRequest({...context,expression:formula.expression,minimum:[X.min,Y.min,Z.min],maximum:[X.max,Y.max,Z.max],
    ...(ranges.tolerance>=4*FUNCTION_CLIP_BOUND_TOLERANCE?{nativePrimitives:true}:{}),
    tolerance:ranges.tolerance,budget:{...FUNCTION_SURFACE_LIMITS,maximumSamples:Math.min(FUNCTION_SURFACE_LIMITS.maximumSamples,MAX_FUNCTION_SURFACE_VERTICES),
      maximumTriangles:Math.min(FUNCTION_SURFACE_LIMITS.maximumTriangles,MAX_FUNCTION_SURFACE_FACES)}});
  const completion=await client.evaluate(request,5000,signal);
  if(!isCurrent() || completion.status==='cancelled') return null;
  if(completion.status!=='result') throw new Error('等式の面を計算しきれませんでした。XYZの範囲を狭めるか、精度を見直してください。');
  const result=completion.result;
  const inputSignature=JSON.stringify({algorithm:'function-implicit-surface/2',expression:request.expression,coefficients:request.coefficients,
    minimum:request.minimum,maximum:request.maximum,tolerance:request.tolerance,budget:request.budget,nativePrimitives:request.nativePrimitives===true});
  const bounds={minimum:request.minimum,maximum:request.maximum};
  if(result.status==='analytic'){
    if(request.nativePrimitives!==true || result.maximumParameterError+FUNCTION_CLIP_BOUND_TOLERANCE>ranges.tolerance) throw new Error('指定精度で解析曲面を作れません。');
    return {kind:'functionSurface',inputSignature,geometry:{primitive:result.primitive,bounds}};
  }
  if(result.status==='invalid') throw new Error(result.message);
  if(result.status==='empty') throw new Error('指定したXYZ範囲内に、この等式を満たす面がありません。');
  if(result.status==='degenerate') throw new Error('等式の解が面として定まりません。式とXYZの範囲を見直してください。');
  if(result.status==='stopped') throw new Error(result.reason==='singular' || result.reason==='unresolved'
    ? '特異点や未解決の領域があり、等式の面を確定できません。範囲や精度を見直してください。'
    : result.reason==='domain' ? '式を連続な実数として計算できない領域があります。XYZの範囲を見直してください。'
      : '指定した範囲・精度で等式の面を計算しきれませんでした。XYZの範囲を狭めるか、精度を見直してください。');
  if(result.status!=='ready') throw new Error('等式の面の生成完了を確認できませんでした。');
  return {kind:'functionSurface',inputSignature,geometry:{...result.mesh,bounds}};
}
