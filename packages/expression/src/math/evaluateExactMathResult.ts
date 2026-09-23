/** Worker-only connection from an exact symbolic result to the established CAD value boundary. */
import { decodeExactMathResult } from './exactMathResult.js';
import { evaluatePreparedScalarMath, type PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import { prepareMathCalculation, prepareExactMathCalculation, type MathCalculationContext } from './prepareMathCalculation.js';
import { exactMathBoolean } from './pruneMathPiecewise.js';
import { type StoredMathContext } from './decodeStoredMath.js';
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';

export interface ExactMathEvaluationContext extends PreparedScalarMathContext {
  readonly references: Pick<StoredMathContext, 'coefficientIds' | 'declaredIds'>;
  readonly resolve: MathCalculationContext['resolve'];
}
function missing(operations: readonly string[] = []): MathEvaluation {
  return { status: 'unresolved', reason: 'missing-condition', names: operations };
}

/** Request identity and the saved angle unit belong to the existing outer Worker envelope. */
export function evaluateExactMathResult(raw: unknown, source: MathNode, context: ExactMathEvaluationContext): MathEvaluation {
  const stop = context.shouldStop(); if (stop !== undefined) return { status: 'stopped', reason: stop };
  try {
    return context.backend.withinDeadline(() => {
      // Never let a simplified result or an omitted engine condition erase an invalid source operand.
      const original = prepareExactMathCalculation(source, context);
      if (original.status !== 'ready') return missing(original.operations);
      const result = decodeExactMathResult(raw, source, {
        operationsById: context.backend.operationsById,
        coefficientIds: context.references.coefficientIds, declaredIds: context.references.declaredIds,
      });
      if (result.status === 'stopped') return { status: result.status, reason: result.reason };
      if (result.status === 'unresolved') return { status: result.status, reason: result.reason, names: [] };
      if (result.status === 'invalid') return {
        status: result.status, reason: result.reason, detail: result.reason === 'divergent'
          ? 'この計算は収束しません。有限の数値として座標には使えません。'
          : result.reason === 'no-limit' ? 'この極限は一定の値に収まりません。左右から近づけた値が異なるか、振動が残っています。'
          : result.reason === 'empty-set' ? '空集合です。このアプリでは空集合の上限・下限・最大値・最小値を定義しません。'
          : result.reason === 'no-extremum' ? 'この集合には、指定した最大値または最小値が存在しません。上限・下限とは区別してください。'
          : '式の成立条件または計算結果を確認してください。',
      };
      if (result.reportedKind === 'equation-system') {
        return { status: 'value', kind: 'equation-system', expression: source, solutions: result.solutions };
      }
      if (result.reportedKind === 'ode-solutions') {
        return { status: 'value', kind: 'ode-solutions', expression: source, solutions: result.solutions };
      }
      if (result.reportedKind === 'fourier-series') {
        return { status: 'value', kind: 'fourier-series', expression: source, series: result.series };
      }
      if (result.reportedKind === 'transform') {
        return { status: 'value', kind: 'transform', expression: source, transform: result.transform };
      }
      if (result.reportedKind === 'series') {
        return { status: 'value', kind: 'series', expression: source, expansion: result.expansion };
      }
      for (const condition of result.domainConditions) {
        const stop = context.shouldStop(); if (stop !== undefined) return { status: 'stopped', reason: stop };
        const prepared = prepareMathCalculation(condition, context);
        if (prepared.status !== 'ready') return missing(prepared.operations);
        // Approximate equality is insufficient to decide an original domain obligation.
        const truth = exactMathBoolean(prepared.expression);
        if (truth === null) return missing();
        if (!truth) return { status: 'invalid', reason: 'domain', detail: '元の式に必要な成立条件を満たしていません。' };
      }
      if (result.reportedKind === 'infinite-bound' || result.reportedKind === 'set' || result.reportedKind === 'interval') {
        return { status: 'value', kind: result.reportedKind, expression: result.expression };
      }
      const prepared = prepareMathCalculation(result.expression, context);
      if (prepared.status !== 'ready') return missing(prepared.operations);
      const stop = context.shouldStop(); if (stop !== undefined) return { status: 'stopped', reason: stop };
      if (result.reportedKind === 'real' || result.reportedKind === 'complex' || result.reportedKind === 'symbolic') {
        // Determine real/complex/symbolic afresh. The engine's reported kind cannot authorize a coordinate.
        return evaluatePreparedScalarMath(prepared.expression, source, context);
      }
      // Preserve exact vector/matrix elements, sets and conditions for explicit selection or display.
      return { status: 'value', kind: result.reportedKind, expression: prepared.expression };
    });
  } catch (error) {
    if (!(error instanceof MathInputProblem)) throw error;
    if (error.code === 'budget') return { status: 'stopped', reason: 'budget' };
    return { status: 'invalid', reason: error.code === 'forbidden' ? 'unsupported' : error.code, detail: error.message };
  }
}
