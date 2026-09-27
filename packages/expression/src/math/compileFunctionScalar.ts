/** Parse once in the isolated math Worker. Sampling never evaluates generated JavaScript. */
import { MathInputProblem } from './mathInputContract.js';
import { readFunctionMathSource, type FunctionMathScope } from './functionMathSource.js';
import { decodeMathCoefficientValues } from './mathWorkRequest.js';
import { coefficientExpressionMap, substituteCoefficientExpressions } from './mathCoefficientExpression.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { evaluatePreparedScalarMath, type PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import { mathScalarValue } from './mathScalarExpression.js';
import { compileScalarMath, type ScalarInput, type ScalarTape } from './scalarMathTape.js';
import { expandFunctionDerivatives } from './functionDerivatives.js';
import { prepareFunctionVectorCalculus } from './prepareFunctionCalculus.js';
import { resolveNumericalRoots } from './numericalRoots.js';

/** This boundary also accepts saved JSON, which must match its displayed source and explicit variable roles. */
export function compileFunctionScalar(definition: unknown, inputs: readonly ScalarInput[], coefficients: unknown,
  context: Omit<PreparedScalarMathContext, 'angleUnit'>): ScalarTape {
  if (inputs.length < 1 || inputs.length > 3 || new Set(inputs).size !== inputs.length
    || inputs.some(input => !['X', 'Y', 'Z', 'T', 'U', 'V'].includes(input))) {
    throw new MathInputProblem('syntax', '関数の独立変数を指定してください。');
  }
  const current = decodeMathCoefficientValues(coefficients);
  const scope: FunctionMathScope = { axes: inputs.filter(input => input === 'X' || input === 'Y' || input === 'Z'),
    parameters: inputs.filter(input => input === 'T' || input === 'U' || input === 'V'), coefficients: current };
  const checkStop = (): void => {
    if (context.shouldStop() !== undefined) throw new MathInputProblem('budget', '関数の計算を中止しました。');
  };
  checkStop();
  const stored = readFunctionMathSource(definition, scope, context.backend);
  const scalarContext: PreparedScalarMathContext = { ...context, angleUnit: stored.angleUnit };
  const substitutedSource = substituteCoefficientExpressions(stored.expression, coefficientExpressionMap(current, stored.angleUnit));
  const ode = context.backend.prepareOdeFunction?.(substitutedSource, scalarContext);
  const numerical = resolveNumericalRoots(ode?.expression ?? substitutedSource, stored.expression, scalarContext);
  if (numerical.evaluation !== undefined) throw new MathInputProblem('domain', '解の区間から使う上下限を明示してください。');
  const substituted = numerical.expression;
  // Check invalid constant operands before any rewrite. Dynamic roots stay in the tape: the
  // interval evaluator must discharge their domain obligations separately on each parameter cell.
  const vector = prepareFunctionVectorCalculus(substituted, inputs, stored.angleUnit);
  const preparedSource = prepareMathCalculation(vector?.expression ?? substituted, { angleUnit: stored.angleUnit, resolve: () => null });
  const expanded = expandFunctionDerivatives(preparedSource.status === 'ready' ? preparedSource.expression : vector?.expression ?? substituted,
    inputs, stored.angleUnit);
  return compileScalarMath(expanded.expression,
    { inputs, angleUnit: stored.angleUnit, domainGuards: [...(ode?.guards ?? []), ...(vector?.guards ?? []), ...expanded.guards], evaluateConstant: node => {
    checkStop();
    const prepared = prepareMathCalculation(node, { angleUnit: stored.angleUnit, resolve: () => null });
    if (prepared.status !== 'ready') throw new MathInputProblem('domain', '関数の定数部分を実数として確定できません。');
    const result = mathScalarValue(evaluatePreparedScalarMath(prepared.expression, node, scalarContext));
    if (!result.ok) throw new MathInputProblem('domain', result.message);
    return result.value;
  } });
}
