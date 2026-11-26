import { ParameterInputError, type FailureText } from '@pointercad/model';
import { failureMessage } from '../i18n/failureMessage.js';
import type { ExportSaveStage } from '../file/fileGateway.js';
import { t, type MessageKey } from '../i18n/t.js';

export function parameterOperationFailure(cause: unknown): string {
  if (cause instanceof ParameterInputError) return failureMessage(cause.text);
  console.error('PointerCAD parameters', cause);
  return t('assembly.error.internal');
}

const CSV_SAVE_FAILURE_KEYS: Readonly<Record<ExportSaveStage | 'save', MessageKey>> = {
  picker: 'parameter.csv.exportPickerFailed',
  create: 'parameter.csv.exportCreateFailed',
  write: 'parameter.csv.exportWriteFailed',
  close: 'parameter.csv.exportCloseFailed',
  save: 'parameter.csv.exportFailed',
};

export function parameterCsvSaveFailure(cause: unknown, stage: ExportSaveStage | 'save'): string {
  console.error('PointerCAD parameter CSV export', stage, cause);
  return t(CSV_SAVE_FAILURE_KEYS[stage]);
}

export function parameterCsvIssueMessage(issue: { readonly recordNumber: number; readonly column: string;
  readonly reason: string; readonly text?: FailureText }): string {
  const reason = issue.text === undefined ? issue.reason : failureMessage(issue.text);
  return `${t('parameter.csv.issueRow')} ${String(issue.recordNumber)} ${issue.column}: ${reason}`;
}

/** Current browser and desktop gateways carry these localized refusals as legacy Error.message. */
export function parameterCsvOpenFailure(cause: unknown): string {
  for (const key of ['file.error.tooLarge', 'file.error.invalidSize', 'file.error.corrupted', 'file.openFailed'] as const) {
    const text = t(key);
    if (cause instanceof Error && cause.message === text) return text;
  }
  return parameterOperationFailure(cause);
}
