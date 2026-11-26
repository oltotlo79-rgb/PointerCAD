import type { PcadSaveWorkerError } from './pcadSaveWorker.js';

export function saveEncodingFailureKey(error: PcadSaveWorkerError): 'file.saveEncodingFailed' | 'assembly.error.internal' {
  if (error.internal && import.meta.env.DEV) console.error('PointerCAD save encoding', error);
  return error.internal ? 'assembly.error.internal' : 'file.saveEncodingFailed';
}

/** Kept in the original exception text for callers that record the diagnostic. */
export const SAVE_RECOVERY_COPY_MARKER = 'PCAD_SAVE_RECOVERY_COPY:';

export class SaveRecoveryCopyError extends AggregateError {
  constructor(errors: readonly unknown[], options?: ErrorOptions) {
    super(errors, `${SAVE_RECOVERY_COPY_MARKER} 保存と復元に失敗しました。元の内容は同じフォルダーの .backup- を含む控えに残しています。`, options);
  }
}

/** Electron sends this receipt as plain data, without exception details or disk paths. */
export const SAVE_RECOVERY_COPY_RECEIPT = { kind: 'saveRecoveryCopyRetained' } as const;

/** Decode before cancellation handling so an existing recovery copy is still reported. */
export function unwrapSaveRecoveryCopyReceipt(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === SAVE_RECOVERY_COPY_RECEIPT.kind) {
    throw new SaveRecoveryCopyError([]);
  }
  return value;
}

export function hasSaveRecoveryCopy(error: unknown): boolean {
  return error instanceof SaveRecoveryCopyError;
}

export function saveFailureMessageKey(error: unknown): 'file.saveFailed' | 'file.saveRecoveryCopyRetained' {
  return hasSaveRecoveryCopy(error) ? 'file.saveRecoveryCopyRetained' : 'file.saveFailed';
}
