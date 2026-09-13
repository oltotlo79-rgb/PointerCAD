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

export async function sampleFunctionCurveGeometry(featureId:string,formula:FunctionFormula,ranges:ResolvedFunctionRanges,
  context:FunctionRequestContext,clients:FunctionRecomputeContext,signal:AbortSignal|undefined,isCurrent:()=>boolean):Promise<FunctionCurveGeometryInput|null> {
  if(formula.kind==='implicit-curve'){
    if(clients.implicitCurves===undefined) throw new Error('等式の曲線の計算部を準備できません。再計算してください。');
    if(ranges.fixedCoordinate===null) throw new Error('等式の曲線で固定する座標を指定してください。');
    const X=ranges.bounds.interval('X'),Y=ranges.bounds.interval('Y'),Z=ranges.bounds.interval('Z');
    const request=decodeFunctionImplicitCurveWorkRequest({...context,expression:formula.expression,fixedAxis:formula.fixedAxis,
      fixedCoordinate:ranges.fixedCoordinate,minimum:[X.min,Y.min,Z.min],maximum:[X.max,Y.max,Z.max],tolerance:ranges.tolerance,
      budget:{maximumSamples:100_000,maximumSegments:100_000,maximumCells:FUNCTION_SURFACE_LIMITS.maximumCells,maximumDepth:FUNCTION_SURFACE_LIMITS.maximumDepth}});
    const completion=await clients.implicitCurves.evaluate(request,5000,signal);
    if(!isCurrent() || completion.status==='cancelled') return null;
    if(completion.status!=='result') throw new Error('等式の曲線を計算しきれませんでした。範囲や精度を見直してください。');
    const result=completion.result,bounds={minimum:request.minimum,maximum:request.maximum};
    if(result.status==='empty') return {featureId,components:[],bounds};
    if(result.status==='invalid') throw new Error(result.message);
    if(result.status!=='ready') throw new Error(result.status==='degenerate'
      ? '指定範囲の等式は長さのある曲線として定まりません。'
      : result.reason==='singular' || result.reason==='unresolved'
        ? '特異点や未解決の領域があり、等式の曲線を確定できません。範囲や精度を見直してください。'
        : '指定した範囲・精度で等式の曲線を計算しきれませんでした。');
    return {featureId,components:result.components,bounds};
  }
  if(formula.kind!=='coordinate-curve' && formula.kind!=='parametric-curve') throw new Error('この曲線の関数形式を計算できません。');
  const request=functionCurveRequest(formula,ranges,context),completion=await clients.curves.evaluate(request,5000,signal);
  if(!isCurrent() || completion.status==='cancelled') return null;
  if(completion.status!=='result') throw new Error('関数の計算を完了できませんでした。範囲や精度を見直してください。');
  const sampled=completion.result,bounds={minimum:request.minimum,maximum:request.maximum};
  if(sampled.status==='empty') return {featureId,components:[],bounds};
  if(sampled.status==='invalid') throw new Error(sampled.message);
  if(sampled.status!=='ready') throw new Error(sampled.status==='degenerate'
    ? '指定範囲の関数は長さのある曲線になりません。'
    : '指定した精度で曲線を計算しきれませんでした。範囲や精度を見直してください。');
  return sampled.bezier === undefined
    ? {featureId,components:sampled.components.map(component=>component.map(sample=>sample.point)),bounds}
    : {featureId,components:[],bezier:sampled.bezier,bounds};
}
