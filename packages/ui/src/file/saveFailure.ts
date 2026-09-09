/** Electron がエラーを直列化しても識別できる、保存失敗の回収情報。パスは含めない。 */
export const SAVE_RECOVERY_COPY_MARKER = 'PCAD_SAVE_RECOVERY_COPY:';

export function hasSaveRecoveryCopy(error: unknown): boolean {
  return error instanceof Error && error.message.includes(SAVE_RECOVERY_COPY_MARKER);
}

export function saveFailureMessageKey(error: unknown): 'file.saveFailed' | 'file.saveRecoveryCopyRetained' {
  return hasSaveRecoveryCopy(error) ? 'file.saveRecoveryCopyRetained' : 'file.saveFailed';
}
