/** Build an immutable Worker request without loading a mathematical engine on the UI thread. */
import { decodeFunctionCurveWorkRequest, type FunctionCurveWorkRequest } from '@pointercad/expression/math/contracts';
import { axisFunctionExpression, type FunctionRequestContext } from './functionRequestInputs.js';
import type { FunctionFormula } from './functionDefinitionTypes.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

export type ExplicitFunctionCurveFormula = Extract<FunctionFormula, { readonly kind: 'coordinate-curve' | 'parametric-curve' }>;
export type FunctionCurveRequestContext = FunctionRequestContext;
export function functionCurveRequest(formula: ExplicitFunctionCurveFormula, ranges: ResolvedFunctionRanges,
  context: FunctionCurveRequestContext): FunctionCurveWorkRequest {
  const { bounds, tolerance } = ranges, X = bounds.interval('X'), Y = bounds.interval('Y'), Z = bounds.interval('Z');
  const parameter = formula.kind === 'parametric-curve' ? ranges.parameters.find(item => item.parameter === 'T')?.range
    : bounds.interval(formula.independent);
  if (parameter === undefined) throw new Error('媒介変数Tの有限な範囲を指定してください。XYZ範囲による代用はできません。');
  const common = { identity: context.identity, coefficients: context.coefficients, lower: parameter.min, upper: parameter.max,
    minimum: [X.min, Y.min, Z.min], maximum: [X.max, Y.max, Z.max], tolerance };
  if (formula.kind === 'parametric-curve') return decodeFunctionCurveWorkRequest({ ...common, independent: 'T',
    outputs: [formula.outputs.X, formula.outputs.Y, formula.outputs.Z] });
  const independent = axisFunctionExpression(formula.independent);
  const outputs = formula.independent === 'X' ? [independent, formula.outputs.Y, formula.outputs.Z]
    : formula.independent === 'Y' ? [formula.outputs.X, independent, formula.outputs.Z] : [formula.outputs.X, formula.outputs.Y, independent];
  return decodeFunctionCurveWorkRequest({ ...common, independent: formula.independent, outputs });
}
