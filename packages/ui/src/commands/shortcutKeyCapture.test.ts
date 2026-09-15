import { describe, expect, it } from 'vitest';
import { captureShortcutKey, type AssignmentKeyEvent } from './shortcutKeyCapture.js';

const key = (key: string, extra: Partial<AssignmentKeyEvent> = {}): AssignmentKeyEvent => ({
  key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, repeat: false,
  getModifierState: () => false, ...extra,
});
describe('割当欄で押したキーを文字入力やウィンドウ操作と区別する', () => {
  it.each(['ctrlKey', 'metaKey'] as const)('%sとShiftを持つキーを同じ保存形へ写す', modifier => {
    expect(captureShortcutKey(key('E', { [modifier]: true, shiftKey: true }))).toEqual({
      status: 'captured', chord: { key: 'e', primary: true, shift: true, alt: false },
    });
  });
  it.each(['Tab', 'F1'])('%sは割当せず、移動と説明を使えるようにする', value => {
    expect(captureShortcutKey(key(value))).toEqual({ status: 'pass-through' });
  });
  it('Escは候補の入力を取り消す', () => {
    expect(captureShortcutKey(key('Escape'))).toEqual({ status: 'cancelled' });
  });
  it.each([{ isComposing: true }, { keyCode: 229 }, { key: 'Process' },
    { ctrlKey: true, altKey: true, getModifierState: (name: string) => name === 'AltGraph' }])(
    '日本語の変換中とAltGrを割当へ取り込まない: %j', extra => {
      expect(captureShortcutKey(key('e', extra))).toEqual({ status: 'rejected', reason: 'composition' });
    });
  it.each(['Control', 'Shift', 'Alt', 'Meta'])('修飾キー%sだけでは変更しない', value => {
    expect(captureShortcutKey(key(value))).toEqual({ status: 'ignored' });
  });
  it('長押しの繰返しは候補を更新しない', () => {
    expect(captureShortcutKey(key('e', { repeat: true }))).toEqual({ status: 'ignored' });
  });
  it.each([key('r', { ctrlKey: true }), key('F4', { altKey: true }), key('F5'), key('F10', { shiftKey: true })])(
    '再読込・窓を閉じる等のキーは受け付けない: %j', event => {
      expect(captureShortcutKey(event)).toEqual({ status: 'rejected', reason: 'reserved' });
    });
  it.each([key('あ'), key('Dead'), key('Unidentified'), key('e', { ctrlKey: true, metaKey: true })])(
    '表現できない押し方を別のキーへ変換しない: %j', event => {
      expect(captureShortcutKey(event)).toEqual({ status: 'rejected', reason: 'unsupported' });
    });
});
