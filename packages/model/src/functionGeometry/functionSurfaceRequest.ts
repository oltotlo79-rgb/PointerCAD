/** Resolve XYZ and parameter intervals first; build a detached, CAD-budgeted request without a UI math engine. */
import { MAX_FUNCTION_SURFACE_FACES, MAX_FUNCTION_SURFACE_VERTICES } from '@pointercad/kernel';
import { decodeFunctionSurfaceWorkRequest, FUNCTION_SURFACE_LIMITS, type FunctionSurfaceWorkRequest } from '@pointercad/expression/math/contracts';
import type { FunctionFormula } from './functionDefinitionTypes.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';
import { axisFunctionExpression, type FunctionRequestContext } from './functionRequestInputs.js';
import { functionParameterBounds } from './functionParameterBounds.js';

export type ExplicitFunctionSurfaceFormula = Extract<FunctionFormula,{readonly kind:'coordinate-surface'|'parametric-surface'}>;
export function functionSurfaceRequest(formula: ExplicitFunctionSurfaceFormula, ranges: ResolvedFunctionRanges,
  context: FunctionRequestContext): FunctionSurfaceWorkRequest {
  const {bounds,tolerance} = ranges, X = bounds.interval('X'), Y = bounds.interval('Y'), Z = bounds.interval('Z');
  const common = {identity:context.identity,coefficients:context.coefficients,minimum:[X.min,Y.min,Z.min],maximum:[X.max,Y.max,Z.max],tolerance,
    budget:{...FUNCTION_SURFACE_LIMITS,maximumSamples:Math.min(FUNCTION_SURFACE_LIMITS.maximumSamples,MAX_FUNCTION_SURFACE_VERTICES),
      maximumTriangles:Math.min(FUNCTION_SURFACE_LIMITS.maximumTriangles,MAX_FUNCTION_SURFACE_FACES)}};
  if (formula.kind === 'parametric-surface') {
    const u = ranges.parameters.find(value=>value.parameter==='U')?.range, v = ranges.parameters.find(value=>value.parameter==='V')?.range;
    if (u === undefined || v === undefined) throw new Error('媒介変数U・Vの有限な範囲を指定してください。XYZ範囲による代用はできません。');
    const parameterBounds = functionParameterBounds(formula.U,formula.V);
    return decodeFunctionSurfaceWorkRequest({...common,independent:['U','V'],lower:[u.min,v.min],upper:[u.max,v.max],
      outputs:[formula.outputs.X,formula.outputs.Y,formula.outputs.Z],...(parameterBounds === undefined ? {} : {parameterBounds})});
  }
  const [x,y,z] = [axisFunctionExpression('X'),axisFunctionExpression('Y'),axisFunctionExpression('Z')];
  const request = formula.output === 'X' ? {independent:['Y','Z'],lower:[Y.min,Z.min],upper:[Y.max,Z.max],outputs:[formula.expression,y,z]}
    : formula.output === 'Y' ? {independent:['X','Z'],lower:[X.min,Z.min],upper:[X.max,Z.max],outputs:[x,formula.expression,z]}
      : {independent:['X','Y'],lower:[X.min,Y.min],upper:[X.max,Y.max],outputs:[x,y,formula.expression]};
  return decodeFunctionSurfaceWorkRequest({...common,...request});
}
