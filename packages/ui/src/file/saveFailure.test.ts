import { describe, expect, it } from 'vitest';
import { SAVE_RECOVERY_COPY_MARKER, SaveRecoveryCopyError, saveFailureMessageKey } from './saveFailure.js';
import { t } from '../i18n/t.js';

describe('保存不能時の回収案内（レビュー R01）', () => {
  it('同じ原文でも控えのある失敗だけ回収方法を案内する', () => {
    const retained = new SaveRecoveryCopyError([]);
    const key = saveFailureMessageKey(retained);
    expect(saveFailureMessageKey(new Error(retained.message))).toBe('file.saveFailed');
    expect(key).toBe('file.saveRecoveryCopyRetained');
    const message = t(key);
    expect(message).toContain('.backup-');
    expect(message).toContain('コピー');
    expect(message).not.toContain(SAVE_RECOVERY_COPY_MARKER);
  });

  it('正常な控えがある証拠がなければ回収できるとは案内しない', () => {
    expect(saveFailureMessageKey(new Error('permission denied'))).toBe('file.saveFailed');
    expect(saveFailureMessageKey(null)).toBe('file.saveFailed');
  });
});
