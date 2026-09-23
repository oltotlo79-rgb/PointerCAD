/** Shared checked numeric boundary for scalar input and the constant portions of a function plot. */
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { encodeMathInRadians } from './mathAngleConvention.js';
import { evaluatePreparedMath } from './numericMathBoundary.js';
import { mathBackendEvaluation, decodeMathBackendNode } from './mathBackendResult.js';
import { numericalIntegral } from './numericalIntegral.js';
import { mathScalarValue } from './mathScalarExpression.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { resolveNumericalRoots } from './numericalRoots.js';

export interface PreparedScalarMathContext {
  readonly backend: MathExecutionBackend;
  readonly angleUnit: 'degree' | 'radian';
  readonly shouldStop: () => 'deadline' | 'cancelled' | undefined;
}
/** Integral subexpressions also need the checked boundary; wrapping one in 2* or +0 must not bypass it. */
function containsIntegral(expression: MathNode): boolean {
  const pending = [expression]; let remaining = 4096;
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '数式の計算範囲が大きすぎます。');
    if (node.kind === 'operation') pending.push(...node.operands);
    else if (node.kind === 'binder') {
      if (node.operation === 'integrate') return true;
      pending.push(node.body);
      for (const binding of node.bindings) {
        if (binding.domain.kind === 'set') pending.push(binding.domain.value);
        else if (binding.domain.kind === 'range') {
          pending.push(binding.domain.lower, binding.domain.upper);
          if (binding.domain.step !== null) pending.push(binding.domain.step);
        }
      }
    }
  }
  return false;
}

/** The source has already passed domain validation/substitution. The caller owns the outer Worker deadline. */
export function evaluatePreparedScalarMath(expression: MathNode, original: MathNode, context: PreparedScalarMathContext): MathEvaluation {
  const stop = context.shouldStop(); if (stop !== undefined) return { status: 'stopped', reason: stop };
  const { backend, angleUnit } = context;
  const numerical = resolveNumericalRoots(expression, original, context);
  if (numerical.evaluation !== undefined) return numerical.evaluation;
  expression = numerical.expression;
  const evaluated = evaluatePreparedMath(backend.box(encodeMathInRadians(expression, backend.operationsById, angleUnit)),
    containsIntegral(expression) ? exact => {
      try { decodeMathBackendNode(exact, backend.operations); return true; }
      catch (error) { if (error instanceof MathInputProblem) return false; throw error; }
    } : undefined);
  if (evaluated.status !== 'requires-deterministic-numeric') {
    return mathBackendEvaluation(evaluated.exact, evaluated.numeric, original, backend.operations);
  }
  const estimate = numericalIntegral(expression, { angleUnit, shouldStop: context.shouldStop,
    evaluateConstant: node => {
      // Nested bounds are subject to the same numeric policy, including rejection of unbounded estimates.
      const value = mathScalarValue(evaluatePreparedScalarMath(node, node, context));
      if (!value.ok) throw new MathInputProblem('domain', value.message);
      return value.value;
    } });
  return estimate ?? { status: 'unresolved', reason: 'unevaluated', names: evaluated.operations };
}
