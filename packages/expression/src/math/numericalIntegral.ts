/** Finite-interval quadrature for a validated continuous scalar integrand. No engine JIT/numerical fallback. */
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { adaptiveIntegral } from './adaptiveIntegral.js';
import { compileScalarMath, createScalarSampler } from './scalarMathTape.js';

export interface NumericalIntegralContext {
  readonly angleUnit: 'degree' | 'radian';
  readonly evaluateConstant: (expression: MathNode) => number;
  readonly shouldStop: () => 'deadline' | 'cancelled' | undefined;
}
const CONTINUOUS_REAL_OPERATIONS = new Set(['add', 'subtract', 'multiply', 'negate', 'square', 'absolute',
  'sin', 'cos', 'sinh', 'cosh', 'tanh', 'arctan', 'arsinh', 'exponential', 'minimum', 'maximum']);

/**
 * Positive domain grammar: do not infer continuity from a handful of finite samples.
 * Logarithms, tangent, variable denominators, arbitrary roots, and nested binders need
 * separate domain analysis before entering this finite-interval algorithm.
 */
function continuousBody(body: MathNode, variable: string, context: NumericalIntegralContext): MathNode | null {
  let remaining = 4096;
  function visit(node: MathNode, depth: number): MathNode | null {
    if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '積分する式が複雑すぎます。');
    if (node.kind === 'number' || node.kind === 'constant') {
      return Number.isFinite(context.evaluateConstant(node)) ? node : null;
    }
    if (node.kind === 'symbol') return node.reference.role === 'bound' && node.reference.id === variable
      ? { kind: 'symbol', reference: { role: 'axis', name: 'X' } } : null;
    if (node.kind !== 'operation') return null;
    if (node.operation === 'power') {
      const exponent = node.operands[1] === undefined ? null : rationalOfExpression(node.operands[1]);
      // Positive integral powers are defined for all real bases. 0^0 is not silently filled in.
      if (exponent === null || exponent.denominator !== 1n || exponent.numerator < 1n || exponent.numerator > 1024n) return null;
    } else if (node.operation === 'divide') {
      const denominator = node.operands[1] === undefined ? null : rationalOfExpression(node.operands[1]);
      if (denominator === null || denominator.numerator === 0n) return null;
    } else if (!CONTINUOUS_REAL_OPERATIONS.has(node.operation)) return null;
    const operands: MathNode[] = [];
    for (const operand of node.operands) {
      const mapped = visit(operand, depth + 1);
      if (mapped === null) return null;
      operands.push(mapped);
    }
    return { ...node, operands };
  }
  return visit(body, 0);
}

/** null means this algorithm has not established the required domain, never an invented scalar. */
export function numericalIntegral(expression: MathNode, context: NumericalIntegralContext): MathEvaluation | null {
  if (expression.kind !== 'binder' || expression.operation !== 'integrate' || expression.bindings.length !== 1) return null;
  const binding = expression.bindings[0];
  if (binding === undefined || binding.domain.kind !== 'range' || binding.domain.step !== null) return null;
  const lower = context.evaluateConstant(binding.domain.lower), upper = context.evaluateConstant(binding.domain.upper);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(upper - lower)) return null;
  const body = continuousBody(expression.body, binding.variable.id, context);
  if (body === null) return null;
  const tape = compileScalarMath(body, { inputs: ['X'], angleUnit: context.angleUnit, evaluateConstant: context.evaluateConstant });
  const maximumEvaluations = Math.min(49_152, Math.floor(1_000_000 / Math.max(1, tape.instructions.length)));
  if (maximumEvaluations < 192) return { status: 'stopped', reason: 'budget' };
  const sample = createScalarSampler(tape);
  const result = adaptiveIntegral(value => sample([value]), lower, upper, { absoluteTolerance: 1e-10, relativeTolerance: 1e-10,
    maximumEvaluations, maximumIntervals: 512, shouldStop: context.shouldStop });
  if (result.status === 'stopped') return { status: 'stopped', reason:
    result.reason === 'deadline' || result.reason === 'cancelled' ? result.reason : 'budget' };
  if (result.status === 'invalid') return { status: 'invalid', reason: 'non-finite', detail: '積分の途中で有限な実数を計算できませんでした。範囲と式を確認してください。' };
  return { status: 'value', kind: 'real', exact: null, decimal: String(result.value), coordinate: result.value,
    approximation: { absoluteError: null, estimatedAbsoluteError: result.estimatedAbsoluteError } };
}
