import { mathNumericalRootResult } from './mathNumericalRootResult.js';
import { mathEquationSystemResult } from './mathEquationSystemResult.js';
import { mathDifferentialEquationResult } from './mathDifferentialEquationResult.js';
import { mathEquationResult } from './mathEquationResult.js';
import { mathFourierSeriesResult } from './mathFourierSeriesResult.js';
import { mathTransformResult, readableMathResult } from './mathTransformResult.js';
import { mathTaylorResult } from './mathTaylorResult.js';
import { t } from '../i18n/t.js';
import type { MathEditorSnapshot } from './MathEditorController.js';
import { MATH_INPUT_LIMITS, type MathEvaluation, type MathNode, type StoredMathExpression } from '@pointercad/expression/math/contracts';

const MATRIX_OPERATIONS: ReadonlySet<string> = new Set(['matrix', 'identity-matrix', 'zero-matrix', 'transpose',
  'conjugate-transpose', 'inverse-matrix']);
/**
 * Candidates come from a written ± or ∓ and from a matrix |A| (read as its determinant and its norm).
 * The saved formula tells which guidance applies; without a ±, the candidates are the |A| readings.
 */
function candidateSources(definition: StoredMathExpression | null): { readonly signs: boolean; readonly matrix: boolean } {
  const matrices = new Set(definition?.declarations?.filter(value => value.type === 'matrix').map(value => value.id));
  const matrixLike = (node: MathNode | undefined): boolean => node?.kind === 'operation'
    ? MATRIX_OPERATIONS.has(node.operation) || node.operation === 'list' && node.operands.length > 0
      && node.operands.every(row => row.kind === 'operation' && row.operation === 'list')
    : node?.kind === 'symbol' && node.reference.role === 'declared' && matrices.has(node.reference.id);
  let signs = false, absolute = false, matrix = false, remaining = MATH_INPUT_LIMITS.nodes;
  const pending: MathNode[] = definition === null ? [] : [definition.expression];
  while (pending.length > 0 && --remaining >= 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (node.kind === 'operation') {
      signs ||= node.operation === 'plus-minus' || node.operation === 'minus-plus';
      if (node.operation === 'absolute') { absolute = true; matrix ||= matrixLike(node.operands[0]); }
      pending.push(...node.operands);
    } else if (node.kind === 'binder') pending.push(node.body);
  }
  return { signs: signs || !absolute, matrix: matrix || (!signs && absolute) };
}

/**
 * A saved integrate(...) with no lower/upper bound is the indefinite form: its value is a whole
 * family of antiderivatives differing by a constant, never one number (MC-20). Detected from the
 * saved formula itself, the same way candidateSources reads ± and |A| above; the definite form
 * (with bounds) is unaffected since its binding domain is 'range', never 'unrestricted'.
 */
function containsIndefiniteIntegral(definition: StoredMathExpression | null): boolean {
  let remaining = MATH_INPUT_LIMITS.nodes;
  const pending: MathNode[] = definition === null ? [] : [definition.expression];
  while (pending.length > 0 && --remaining >= 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (node.kind === 'binder') {
      if (node.operation === 'integrate' && node.bindings.some(binding => binding.domain.kind === 'unrestricted')) return true;
      pending.push(node.body);
    } else if (node.kind === 'operation') pending.push(...node.operands);
  }
  return false;
}

/**
 * True when the node tree contains a natural-log operation, rendered "ln(" by readableMathResult below (MC-20c).
 * Real ln is undefined for a non-positive argument; a reader working over the reals reads such an ln(u) as
 * ln|u| instead, the difference being absorbed into the antiderivative's own +C. Detected from the operation
 * itself, the same way containsIndefiniteIntegral above reads the saved formula, not from the rendered text.
 */
function containsNaturalLog(node: MathNode): boolean {
  let remaining = MATH_INPUT_LIMITS.nodes;
  const pending: MathNode[] = [node];
  while (pending.length > 0 && --remaining >= 0) {
    const current = pending.pop(); if (current === undefined) break;
    if (current.kind === 'operation') {
      if (current.operation === 'natural-log') return true;
      pending.push(...current.operands);
    } else if (current.kind === 'binder') pending.push(current.body);
  }
  return false;
}

/**
 * The exact answer to a whole-formula indefinite integral is a function of that integral's own variable (MC-20):
 * a lambda over the same binding. Like every 'function' result it is never a coordinate, component or coefficient.
 */
function antiderivativeOf(definition: StoredMathExpression | null, evaluation: MathEvaluation): { readonly variable: string; readonly body: MathNode } | null {
  const root = definition?.expression;
  if (evaluation.status !== 'value' || evaluation.kind !== 'function' || root?.kind !== 'binder' || root.operation !== 'integrate'
    || root.bindings.length !== 1 || root.bindings[0].domain.kind !== 'unrestricted') return null;
  const answer = evaluation.expression, variable = root.bindings[0].variable;
  return answer.kind === 'binder' && answer.operation === 'lambda' && answer.bindings.length === 1
    && answer.bindings[0].domain.kind === 'unrestricted' && answer.bindings[0].variable.id === variable.id
    && answer.bindings[0].variable.label === variable.label ? { variable: variable.label, body: answer.body } : null;
}

export interface MathEditorResultText {
  readonly message: string;
  readonly detail: string;
  readonly hasError: boolean;
  readonly busy: boolean;
}
export function mathEditorResultText(snapshot: MathEditorSnapshot): MathEditorResultText {
  const result = (message: string, detail = '', hasError = false, busy = false): MathEditorResultText => ({ message, detail, hasError, busy });
  if (snapshot.problem === 'source-limit') return result(t('math.sourceTooLong'), '', true);
  if (snapshot.problem === 'conversion') return result(t('math.conversionFailed'), '', true);
  if (snapshot.problem === 'insertion') return result(t('math.insertionFailed'), '', true);
  if (snapshot.phase === 'runtime-loading' || snapshot.phase === 'symbolic-import') {
    return result(t('math.preparingExact'), t('math.preparingExactHint'), false, true);
  }
  if (snapshot.phase === 'calculating') return result(t('math.calculating'), '', false, true);
  const state = snapshot.state;
  if (state.status === 'editing') return result(t('math.editing'));
  if (state.status === 'calculating') return result(t('math.calculating'), '', false, true);
  if (state.status === 'rejected') return result(t(state.reason === 'source' ? 'math.invalidSource' : 'math.workerFailed'), '', true);
  const evaluation = state.output.evaluation;
  if (evaluation.status === 'invalid') return result(evaluation.detail, '', true);
  if (evaluation.status === 'stopped') return result(t(`math.${evaluation.reason}`));
  if (evaluation.status === 'unresolved') return result(t('math.unresolved'), evaluation.names.join('、'));
  if (evaluation.status === 'multiple') {
    const sources = candidateSources(state.output.definition);
    const hints = [...(sources.signs ? [t('math.multipleSelectionHint')] : []), ...(sources.matrix ? [t('math.absoluteSelectionHint')] : [])];
    return result(t('math.multiple'),
      `${t(sources.signs ? 'math.multipleCandidates' : 'math.absoluteCandidates')}: ${evaluation.candidates.map(readableMathResult).join(', ')}. ${hints.join(' ')}`
      + (evaluation.exhaustive ? '' : ` ${t('math.notExhaustive')}`));
  }
  const equation = mathEquationResult(evaluation, state.output.definition?.expression);
  if (equation !== null) return result(equation.message, equation.detail);
  if (evaluation.kind === 'root-intervals') {
    const display = mathNumericalRootResult(evaluation);
    return result(display.message, display.detail);
  }
  if (evaluation.kind === 'equation-system') {
    const display = mathEquationSystemResult(evaluation);
    return result(display.message, display.detail);
  }
  if (evaluation.kind === 'ode-solutions') {
    const display = mathDifferentialEquationResult(evaluation);
    return result(display.message, display.detail);
  }
  if (evaluation.kind === 'fourier-series') {
    const display = mathFourierSeriesResult(evaluation);
    return result(display.message, display.detail);
  }
  if (evaluation.kind === 'transform') {
    const display = mathTransformResult(evaluation);
    return result(display.message, display.detail);
  }
  if (evaluation.kind === 'series') {
    const display = mathTaylorResult(evaluation);
    return result(display.message, display.detail);
  }
  if (evaluation.kind === 'boolean' && evaluation.expression.kind === 'constant') {
    if (evaluation.expression.name === 'true') return result(t('math.boolean.true'));
    if (evaluation.expression.name === 'false') return result(t('math.boolean.false'));
  }
  if (evaluation.kind === 'infinite-bound') {
    return result(t(evaluation.expression.kind === 'operation' ? 'math.infiniteBound.negative' : 'math.infiniteBound.positive'), t('math.infiniteBound.hint'));
  }
  if (evaluation.kind === 'symbolic' && containsIndefiniteIntegral(state.output.definition)) {
    return result(t('math.indefiniteIntegral.result'), t('math.indefiniteIntegral.hint'));
  }
  const antiderivative = antiderivativeOf(state.output.definition, evaluation);
  if (antiderivative !== null) {
    // A variable already called C would be indistinguishable from the constant: name the constant K instead.
    const constant = antiderivative.variable === 'C' ? 'K' : 'C';
    const hint = t(constant === 'C' ? 'math.indefiniteIntegral.hint' : 'math.indefiniteIntegral.hintConstantK');
    // Only an antiderivative written with ln needs the real-vs-complex reading note (MC-20c decision).
    const detail = containsNaturalLog(antiderivative.body) ? `${hint} ${t('math.indefiniteIntegral.lnRealNote')}` : hint;
    return result(`${t('math.indefiniteIntegral.antiderivative')}: ${readableMathResult(antiderivative.body)} + ${constant}`, detail);
  }
  if (evaluation.kind !== 'real') return result(t(`math.kind.${evaluation.kind}`));
  const approximation = evaluation.approximation;
  const estimate = approximation?.estimatedAbsoluteError;
  const detail = estimate !== undefined ? `${t('math.errorEstimate')}: ${estimate}。${t('math.errorUnknown')}`
    : approximation === null ? '' : approximation.absoluteError === null ? t('math.errorUnknown')
    : `${t('math.errorBound')}: ${approximation.absoluteError}`;
  return result(`${estimate === undefined ? '=' : '≈'} ${evaluation.decimal}`, detail);
}
