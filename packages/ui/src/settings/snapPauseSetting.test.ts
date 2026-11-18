import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings, type SettingsStorage } from './settings.js';
import { currentSnapPauseModifier, snapPauseHeld, snapPauseModifierOf, SNAP_PAUSE_MODIFIERS } from './snapPauseSetting.js';

/* 設計 B-09 3-2: 吸着を一時止める修飾キー。既定は止めない。保存の値は知らない値を既定へ戻す。 */
const KEYS_UP = { shiftKey: false, ctrlKey: false, metaKey: false };

function memoryStorage(): SettingsStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe('吸着を一時止める修飾キーの値', () => {
  it('選べるのは なし・Shift・Ctrl の 3 つで、既定は なし', () => {
    expect([...SNAP_PAUSE_MODIFIERS]).toEqual(['none', 'shift', 'ctrl']);
    expect(DEFAULT_DISPLAY_SETTINGS.snapPauseModifier).toBe('none');
    expect(currentSnapPauseModifier(undefined)).toBe('none');
    expect(currentSnapPauseModifier({})).toBe('none');
    expect(currentSnapPauseModifier({ snapPauseModifier: 'shift' })).toBe('shift');
  });

  it('知らない値・形の違う値は読まない', () => {
    for (const value of SNAP_PAUSE_MODIFIERS) expect(snapPauseModifierOf(value)).toBe(value);
    for (const value of ['alt', 'Shift', '', '__proto__', 1, null, undefined, ['shift'], { shift: true }]) {
      expect(snapPauseModifierOf(value), JSON.stringify([value])).toBeNull();
    }
  });

  it('なし は何を押しても止めず、Shift は Shift だけ、Ctrl は Ctrl と Mac の Cmd で止める', () => {
    const shift = { ...KEYS_UP, shiftKey: true }, ctrl = { ...KEYS_UP, ctrlKey: true }, meta = { ...KEYS_UP, metaKey: true };
    for (const keys of [KEYS_UP, shift, ctrl, meta]) expect(snapPauseHeld('none', keys)).toBe(false);
    expect([KEYS_UP, shift, ctrl, meta].map(keys => snapPauseHeld('shift', keys))).toEqual([false, true, false, false]);
    expect([KEYS_UP, shift, ctrl, meta].map(keys => snapPauseHeld('ctrl', keys))).toEqual([false, false, true, true]);
  });

  it('端末に保存して読み戻し、知らない値が保存されていれば既定(止めない)へ戻す', () => {
    const storage = memoryStorage();
    saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, snapPauseModifier: 'ctrl' }, storage);
    expect(loadSettings(storage).snapPauseModifier).toBe('ctrl');
    const written = storage.values.get('pointercad.settings');
    expect(written).toBeDefined();
    storage.setItem('pointercad.settings', (written ?? '').replace('"snapPauseModifier":"ctrl"', '"snapPauseModifier":"alt"'));
    expect(loadSettings(storage).snapPauseModifier).toBe('none');
  });
});
