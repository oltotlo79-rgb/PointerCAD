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
import { FailureTextError, plainText } from '../failureText.js';
import { functionPlotStopped, functionPlotWorkerFailure } from './functionPlotFailure.js';

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
  if(completion.status!=='result') throw functionPlotWorkerFailure('implicitSurface', completion.status);
  const result=completion.result;
  const inputSignature=JSON.stringify({algorithm:'function-implicit-surface/2',expression:request.expression,coefficients:request.coefficients,
    minimum:request.minimum,maximum:request.maximum,tolerance:request.tolerance,budget:request.budget,nativePrimitives:request.nativePrimitives===true});
  const bounds={minimum:request.minimum,maximum:request.maximum};
  if(result.status==='analytic'){
    if(request.nativePrimitives!==true || result.maximumParameterError+FUNCTION_CLIP_BOUND_TOLERANCE>ranges.tolerance) throw new Error('Analytic function surface reply exceeds the requested tolerance or was not requested');
    return {kind:'functionSurface',inputSignature,geometry:{primitive:result.primitive,bounds}};
  }
  if(result.status==='invalid') throw new FailureTextError(plainText(result.message));
  if(result.status==='empty') throw new FailureTextError({ key: 'functionPlot.failure.implicitSurfaceEmpty', parameters: {} });
  if(result.status==='stopped') {
    if(result.reason==='cancelled') return null;
    throw functionPlotStopped('implicitSurface', result.reason);
  }
  if(result.status!=='ready') throw new FailureTextError({ key: 'functionPlot.failure.implicitSurfaceDegenerate', parameters: {} });
  return {kind:'functionSurface',inputSignature,geometry:{...result.mesh,bounds}};
}
