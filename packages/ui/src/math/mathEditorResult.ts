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
  if (evaluation.kind !== 'real') return result(t(`math.kind.${evaluation.kind}`));
  const approximation = evaluation.approximation;
  const estimate = approximation?.estimatedAbsoluteError;
  const detail = estimate !== undefined ? `${t('math.errorEstimate')}: ${estimate}。${t('math.errorUnknown')}`
    : approximation === null ? '' : approximation.absoluteError === null ? t('math.errorUnknown')
    : `${t('math.errorBound')}: ${approximation.absoluteError}`;
  return result(`${estimate === undefined ? '=' : '≈'} ${evaluation.decimal}`, detail);
}
