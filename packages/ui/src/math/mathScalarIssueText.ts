import { inspectMathScalarExpression, type MathScalarIssue } from '@pointercad/expression';
import { t, type MessageKey } from '../i18n/t.js';
import type { MathEditorOutput } from './mathEditorSession.js';

const SCALAR_ISSUE_KEYS = {
  stopped: 'mathScalar.stopped',
  notUniqueReal: 'mathScalar.notUniqueReal',
  inexactCoordinate: 'mathScalar.inexactCoordinate',
  outOfRange: 'mathScalar.outOfRange',
  sourceUnavailable: 'mathScalar.sourceUnavailable',
  internal: 'assembly.error.internal',
} satisfies Record<Exclude<MathScalarIssue['code'], 'invalidEvaluation'>, MessageKey>;

export function mathScalarIssueText(issue: MathScalarIssue): string {
  return issue.code === 'invalidEvaluation' ? issue.evaluation.detail : t(SCALAR_ISSUE_KEYS[issue.code]);
}

export function canApplyMathScalar(output: MathEditorOutput): boolean {
  const scalar = inspectMathScalarExpression(output);
  if (!scalar.ok && scalar.issue.code === 'internal' && import.meta.env.DEV) {
    console.error('PointerCAD math scalar acceptance', scalar.issue.reason, scalar.issue.cause);
  }
  return scalar.ok;
}
