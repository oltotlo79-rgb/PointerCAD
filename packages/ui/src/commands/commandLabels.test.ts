import { describe, expect, it } from 'vitest';
import { currentCommandLabel } from './commandLabels.js';

describe('ボタンのキー表示は実際の割当と文書の種類へ追従する', () => {
  it('変更・割当なし・既定への復元を表示し、古いキーを残さない', () => {
    expect(currentCommandLabel('history.undo', {}, 'part')).toBe('元に戻す (Ctrl+Z)');
    expect(currentCommandLabel('history.undo', { 'history.undo': { key: 'f2', primary: false, shift: false, alt: false } }, 'part'))
      .toBe('元に戻す (F2)');
    expect(currentCommandLabel('history.undo', { 'history.undo': null }, 'part')).toBe('元に戻す');
    expect(currentCommandLabel('history.undo', {}, 'drawing')).toBe('元に戻す (Ctrl/Cmd+Z)');
  });
});
