/** Build an immutable Worker request without loading a mathematical engine on the UI thread. */
import { decodeFunctionCurveWorkRequest, type FunctionCurveWorkRequest, type MathNode } from '@pointercad/expression/math/contracts';
import type { StoredMathExpression } from '@pointercad/expression';
import { axisFunctionExpression, type FunctionRequestContext } from './functionRequestInputs.js';
import type { FunctionFormula } from './functionDefinitionTypes.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

export type ExplicitFunctionCurveFormula = Extract<FunctionFormula, { readonly kind: 'coordinate-curve' | 'parametric-curve' }>;
export type FunctionCurveRequestContext = FunctionRequestContext;
export interface FunctionCurveRequestOptions {
  /**
   * Attach the original T.min/T.max expressions so the Worker can prove periodic intent. Off by default: point
   * requests spread this request into a strictly decoded point request and must keep the previous fields.
   */
  readonly periodicIntent?: boolean;
}

/** Coefficient ids referenced by a closed range expression; null when it uses any other symbol or a local definition. */
function coefficientIds(definition: StoredMathExpression): Set<string> | null {
  if (definition.declarations !== undefined && definition.declarations.length > 0) return null;
  const ids = new Set<string>(), pending: MathNode[] = [definition.expression];
  for (let budget = 4096; pending.length > 0; budget--) {
    const node = pending.pop();
    if (node === undefined || budget < 0) return null;
    if (node.kind === 'binder') return null;
    if (node.kind === 'symbol') {
      if (node.reference.role !== 'coefficient') return null;
      ids.add(node.reference.id);
    } else if (node.kind === 'operation') pending.push(...node.operands);
  }
  return ids;
}
/** The persisted T bounds as original expressions, only when both exist and use the request's own coefficients. */
function parameterSources(formula: Extract<FunctionFormula, { readonly kind: 'parametric-curve' }>, context: FunctionCurveRequestContext) {
  const lower = formula.T.min.mathDefinition, upper = formula.T.max.mathDefinition;
  if (lower === undefined || upper === undefined) return {};
  const known = new Set(context.coefficients.map(coefficient => coefficient.id));
  const used = [coefficientIds(lower), coefficientIds(upper)];
  if (used.some(ids => ids === null || [...ids].some(id => !known.has(id)))) return {};
  return { parameterSources: { lower, upper } };
}

export function functionCurveRequest(formula: ExplicitFunctionCurveFormula, ranges: ResolvedFunctionRanges,
  context: FunctionCurveRequestContext, options: FunctionCurveRequestOptions = {}): FunctionCurveWorkRequest {
  const { bounds, tolerance } = ranges, X = bounds.interval('X'), Y = bounds.interval('Y'), Z = bounds.interval('Z');
  const parameter = formula.kind === 'parametric-curve' ? ranges.parameters.find(item => item.parameter === 'T')?.range
    : bounds.interval(formula.independent);
  if (parameter === undefined) throw new Error('媒介変数Tの有限な範囲を指定してください。XYZ範囲による代用はできません。');
  const common = { identity: context.identity, coefficients: context.coefficients, lower: parameter.min, upper: parameter.max,
    minimum: [X.min, Y.min, Z.min], maximum: [X.max, Y.max, Z.max], tolerance };
  if (formula.kind === 'parametric-curve') return decodeFunctionCurveWorkRequest({ ...common, independent: 'T',
    outputs: [formula.outputs.X, formula.outputs.Y, formula.outputs.Z], ...(options.periodicIntent === true ? parameterSources(formula, context) : {}) });
  const independent = axisFunctionExpression(formula.independent);
  const outputs = formula.independent === 'X' ? [independent, formula.outputs.Y, formula.outputs.Z]
    : formula.independent === 'Y' ? [formula.outputs.X, independent, formula.outputs.Z] : [formula.outputs.X, formula.outputs.Y, independent];
  return decodeFunctionCurveWorkRequest({ ...common, independent: formula.independent, outputs });
}
