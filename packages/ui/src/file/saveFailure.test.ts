import { describe, expect, it } from 'vitest';
import { SAVE_RECOVERY_COPY_MARKER, saveFailureMessageKey } from './saveFailure.js';
import { t } from '../i18n/t.js';

describe('保存不能時の回収案内（レビュー R01）', () => {
  it('IPC 越しのエラーでも回収方法を案内する', () => {
    const key = saveFailureMessageKey(new Error(`Error invoking remote method 'pcad:save': Error: ${SAVE_RECOVERY_COPY_MARKER} recovery retained`));
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
