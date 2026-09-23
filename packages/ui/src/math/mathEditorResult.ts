import { mathNumericalRootResult } from './mathNumericalRootResult.js';
import { mathEquationSystemResult } from './mathEquationSystemResult.js';
import { mathDifferentialEquationResult } from './mathDifferentialEquationResult.js';
import { mathEquationResult } from './mathEquationResult.js';
import { mathFourierSeriesResult } from './mathFourierSeriesResult.js';
import { mathTransformResult } from './mathTransformResult.js';
import { mathTaylorResult } from './mathTaylorResult.js';
import { t } from '../i18n/t.js';
import type { MathEditorSnapshot } from './MathEditorController.js';

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
  if (evaluation.status === 'multiple') return result(t('math.multiple'), evaluation.exhaustive ? '' : t('math.notExhaustive'));
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
  if (evaluation.kind !== 'real') return result(t(`math.kind.${evaluation.kind}`));
  const approximation = evaluation.approximation;
  const estimate = approximation?.estimatedAbsoluteError;
  const detail = estimate !== undefined ? `${t('math.errorEstimate')}: ${estimate}。${t('math.errorUnknown')}`
    : approximation === null ? '' : approximation.absoluteError === null ? t('math.errorUnknown')
    : `${t('math.errorBound')}: ${approximation.absoluteError}`;
  return result(`${estimate === undefined ? '=' : '≈'} ${evaluation.decimal}`, detail);
}
