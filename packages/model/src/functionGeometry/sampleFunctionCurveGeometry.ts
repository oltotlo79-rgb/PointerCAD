/** Both explicit and planar implicit definitions feed the same normal CAD curve stage. */
import {
  decodeFunctionImplicitCurveWorkRequest,
  FUNCTION_SURFACE_LIMITS,
} from '@pointercad/expression/math/contracts';

import type { FunctionFormula } from './functionDefinitionTypes.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';
import type { FunctionRequestContext } from './functionRequestInputs.js';
import type { FunctionRecomputeContext } from './recomputeFunctionCurves.js';
import type { FunctionCurveGeometryInput } from './functionCurveGeometry.js';
import { functionCurveRequest } from './functionCurveRequest.js';
import { FailureTextError, plainText } from '../failureText.js';
import { functionPlotStopped, functionPlotWorkerFailure } from './functionPlotFailure.js';

export async function sampleFunctionCurveGeometry(featureId:string,formula:FunctionFormula,ranges:ResolvedFunctionRanges,
  context:FunctionRequestContext,clients:FunctionRecomputeContext,signal:AbortSignal|undefined,isCurrent:()=>boolean):Promise<FunctionCurveGeometryInput|null> {
  if(formula.kind==='implicit-curve'){
    if(clients.implicitCurves===undefined) throw new FailureTextError({ key: 'functionPlot.failure.implicitCurveUnavailable', parameters: {} });
    if(ranges.fixedCoordinate===null) throw new Error('Resolved implicit curve has no fixed coordinate');
    const X=ranges.bounds.interval('X'),Y=ranges.bounds.interval('Y'),Z=ranges.bounds.interval('Z');
    const request=decodeFunctionImplicitCurveWorkRequest({...context,expression:formula.expression,fixedAxis:formula.fixedAxis,
      fixedCoordinate:ranges.fixedCoordinate,minimum:[X.min,Y.min,Z.min],maximum:[X.max,Y.max,Z.max],tolerance:ranges.tolerance,
      budget:{maximumSamples:100_000,maximumSegments:100_000,maximumCells:FUNCTION_SURFACE_LIMITS.maximumCells,maximumDepth:FUNCTION_SURFACE_LIMITS.maximumDepth}});
    const completion=await clients.implicitCurves.evaluate(request,5000,signal);
    if(!isCurrent() || completion.status==='cancelled') return null;
    if(completion.status!=='result') throw functionPlotWorkerFailure('implicitCurve', completion.status);
    const result=completion.result,bounds={minimum:request.minimum,maximum:request.maximum};
    if(result.status==='empty') return {featureId,components:[],bounds};
    if(result.status==='invalid') throw new FailureTextError(plainText(result.message));
    if(result.status==='degenerate') throw new FailureTextError({ key: 'functionPlot.failure.implicitCurveDegenerate', parameters: {} });
    if(result.status==='stopped') {
      if(result.reason==='cancelled') return null;
      throw functionPlotStopped('implicitCurve', result.reason);
    }
    return {featureId,components:result.components,bounds};
  }
  if(formula.kind!=='coordinate-curve' && formula.kind!=='parametric-curve') throw new Error(`Unexpected formula for a function curve: ${formula.kind}`);
  // Only this geometry route carries the original T bounds; point requests keep the previous request fields.
  const request=functionCurveRequest(formula,ranges,context,{periodicIntent:true}),completion=await clients.curves.evaluate(request,5000,signal);
  if(!isCurrent() || completion.status==='cancelled') return null;
  if(completion.status!=='result') throw functionPlotWorkerFailure('curve', completion.status);
  const sampled=completion.result,bounds={minimum:request.minimum,maximum:request.maximum};
  if(sampled.status==='empty') return {featureId,components:[],bounds};
  if(sampled.status==='invalid') throw new FailureTextError(plainText(sampled.message));
  if(sampled.status==='stopped') {
    if(sampled.reason==='cancelled') return null;
    throw functionPlotStopped('curve', sampled.reason);
  }
  if(sampled.status!=='ready') throw new FailureTextError({ key: 'functionPlot.failure.curveDegenerate', parameters: {} });
  if(sampled.bezier!==undefined) return {featureId,components:[],bezier:sampled.bezier,bounds};
  const components=sampled.components.map(component=>component.map(sample=>sample.point));
  // The certified samples stay alongside their proved C1 cubic; the CAD stage checks one against the other.
  return sampled.smooth===undefined
    ? {featureId,components,bounds}
    : {featureId,components,splines:sampled.smooth.splines,bounds};
}
