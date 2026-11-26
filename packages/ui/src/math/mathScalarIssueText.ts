import { inspectMathScalarExpression, type MathScalarIssue } from '@pointercad/expression';
import { failureMessage } from '../i18n/failureMessage.js';
import { t, type MessageKey } from '../i18n/t.js';
import type { MathEditorOutput } from './mathEditorSession.js';

const SCALAR_ISSUE_KEYS = {
  notUniqueReal: 'mathScalar.notUniqueReal',
  inexactCoordinate: 'mathScalar.inexactCoordinate',
  outOfRange: 'mathScalar.outOfRange',
  sourceUnavailable: 'mathScalar.sourceUnavailable',
  internal: 'assembly.error.internal',
} satisfies Record<Exclude<MathScalarIssue['code'], 'invalidEvaluation' | 'stopped'>, MessageKey>;

export function mathScalarIssueText(issue: MathScalarIssue): string {
  if (issue.code === 'invalidEvaluation') {
    return issue.evaluation.diagnostic === undefined ? issue.evaluation.detail : failureMessage(issue.evaluation.diagnostic);
  }
  if (issue.code === 'stopped') {
    return issue.evaluation.diagnostic === undefined ? t('mathScalar.stopped') : failureMessage(issue.evaluation.diagnostic);
  }
  return t(SCALAR_ISSUE_KEYS[issue.code]);
}

export function canApplyMathScalar(output: MathEditorOutput): boolean {
  const scalar = inspectMathScalarExpression(output);
  if (!scalar.ok && scalar.issue.code === 'internal' && import.meta.env.DEV) {
    console.error('PointerCAD math scalar acceptance', scalar.issue.reason, scalar.issue.cause);
  }
  return scalar.ok;
}
