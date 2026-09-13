/** Only exact identities between this surface's parameter boundaries authorize shared topology. */
import { MathInputProblem, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { readFunctionMathSource } from './functionMathSource.js';
import { functionBoundaryKey } from './functionBoundaryCanonical.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { evaluatePreparedScalarMath, type PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import { mathScalarValue } from './mathScalarExpression.js';
import type { FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { coefficientExpression, substituteCoefficientExpressions, coefficientExpressionMap } from './mathCoefficientExpression.js';

export interface FunctionSurfaceBoundary {
  readonly periodic: readonly [boolean,boolean];
  /** [U lower/upper, V lower/upper]. True only if the entire boundary is a single point. */
  readonly poles: readonly [readonly [boolean,boolean],readonly [boolean,boolean]];
}
export function proveFunctionSurfaceBoundary(request: FunctionSurfaceWorkRequest,
  context: Omit<PreparedScalarMathContext,'angleUnit'>): FunctionSurfaceBoundary | undefined {
  if (request.independent[0] !== 'U' || request.parameterBounds === undefined) return undefined;
  const { backend } = context, coefficients = new Map(request.coefficients.map(item => [item.id,item]));
  const scope = { axes: [],parameters: [],coefficients: request.coefficients };
  const stop = () => { if (context.shouldStop() !== undefined) throw new MathInputProblem('budget','周期境界の確認を中止しました。'); };
  const coefficient = (id: string): MathNode => {
    const value = coefficients.get(id); if (value === undefined) throw new MathInputProblem('syntax','境界式の係数が見つかりません。');
    return coefficientExpression(value);
  };
  const checked = (raw: StoredMathExpression, expected: number): StoredMathExpression => backend.withinDeadline(() => {
    stop(); const definition = readFunctionMathSource(raw,scope,backend);
    const substituted = substituteCoefficientExpressions(definition.expression, coefficientExpressionMap(request.coefficients, definition.angleUnit));
    const prepared = prepareMathCalculation(substituted,{angleUnit:definition.angleUnit,resolve:()=>null});
    if (prepared.status !== 'ready') throw new MathInputProblem('domain','媒介変数の境界値を確定できません。');
    const result = mathScalarValue(evaluatePreparedScalarMath(prepared.expression,definition.expression,{...context,angleUnit:definition.angleUnit}));
    if (!result.ok || result.value !== expected) throw new MathInputProblem('domain','媒介変数の境界式と現在の値が一致しません。');
    return definition;
  });
  const low = request.parameterBounds.lower.map((value,axis) => checked(value,request.lower[axis]));
  const high = request.parameterBounds.upper.map((value,axis) => checked(value,request.upper[axis]));
  const outputs = request.outputs.map(value => backend.withinDeadline(() => readFunctionMathSource(value,
    {...scope,parameters:['U','V']},backend)));
  const keys = (fixed: ReadonlyMap<string,StoredMathExpression>) => outputs.map(output => {
    stop(); return functionBoundaryKey(output.expression,output.angleUnit,reference => reference.role === 'coefficient'
      ? {expression:coefficient(reference.id),angleUnit:'radian'} : reference.role === 'parameter' ? fixed.get(reference.name) ?? null : null);
  });
  const same = (a: readonly (string|null)[], b: readonly (string|null)[]) => a.every((value,index) => value !== null && value === b[index]);
  const periodic: [boolean,boolean] = [false,false], poles: [[boolean,boolean],[boolean,boolean]] = [[false,false],[false,false]];
  for (const axis of [0,1] as const) {
    const name = axis === 0 ? 'U' : 'V', other = axis === 0 ? 'V' : 'U';
    const a = keys(new Map([[name,low[axis]]])), b = keys(new Map([[name,high[axis]]]));
    periodic[axis] = same(a,b);
    poles[axis][0] = same(a,keys(new Map([[name,low[axis]],[other,low[1-axis]]])));
    poles[axis][1] = same(b,keys(new Map([[name,high[axis]],[other,low[1-axis]]])));
  }
  return {periodic,poles};
}
