import { describe, expect, it } from 'vitest';
import { settingsStorage } from './cameraSettingsPersistence.testSupport.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings } from './settings.js';
import {
  addsToSelection, currentSelectionModifier, LOCAL_SELECTION_MODIFIERS, SELECTION_MODIFIERS, selectionModifierOf,
} from './selectionModifierSetting.js';

// none, Shift, Ctrl, Cmd, Shift+Ctrl, Shift+Cmd, Ctrl+Cmd, all three.
const keys = [
  [false, false, false], [true, false, false], [false, true, false], [false, false, true],
  [true, true, false], [true, false, true], [false, true, true], [true, true, true],
].map(([shiftKey, ctrlKey, metaKey]) => ({ shiftKey, ctrlKey, metaKey }));

const legacyEither = [false, true, true, false, true, true, true, true];
const shift = [false, true, false, false, true, true, false, true];
const ctrl = [false, false, true, true, true, true, true, true];
const either = [false, true, true, true, true, true, true, true];

describe('場所ごとの選択キー', () => {
  it.each([
    ['partViewport', legacyEither], ['assemblyViewport', shift], ['drawingCanvas', legacyEither],
    ['featureTree', legacyEither], ['assemblyTree', shift], ['radialMenu', legacyEither],
    // 図面の木(DrawingTree.tsx)の今の判定は event.ctrlKey || event.metaKey(Shift は足さない)。
    ['drawingTree', ctrl],
  ] as const)('%s は既定で従来と同じで、明示した設定では全ての場所が同じ', (surface, legacy) => {
    const local = LOCAL_SELECTION_MODIFIERS[surface];
    for (const [setting, expected] of [[undefined, legacy], ['local', legacy], ['shift', shift], ['ctrl', ctrl], ['shiftOrCtrl', either]] as const) {
      expect(keys.map(event => addsToSelection(setting, event, local)), String(setting)).toEqual(expected);
    }
  });

  it('選べる4値を保存して読み戻す', () => {
    expect(SELECTION_MODIFIERS).toEqual(['local', 'shiftOrCtrl', 'shift', 'ctrl']);
    expect(DEFAULT_DISPLAY_SETTINGS.selectionModifier).toBe('local');
    for (const setting of SELECTION_MODIFIERS) {
      const { storage } = settingsStorage();
      expect(selectionModifierOf(setting)).toBe(setting);
      saveSettings({ ...DEFAULT_DISPLAY_SETTINGS, selectionModifier: setting }, storage);
      expect(loadSettings(storage).selectionModifier).toBe(setting);
    }
  });

  it('欄のない古い保存・知らない値はこの欄だけ場所ごとの既定へ戻す', () => {
    expect(currentSelectionModifier(undefined)).toBe('local');
    for (const value of [undefined, 'Alt', null, 9, ['shift']]) {
      expect(selectionModifierOf(value)).toBeNull();
      expect(currentSelectionModifier({ selectionModifier: value })).toBe('local');
      const stored = JSON.stringify({ theme: 'light', uiScale: 120, snapPauseModifier: 'shift', selectionModifier: value });
      expect(loadSettings(settingsStorage(stored).storage)).toMatchObject({
        selectionModifier: 'local', snapPauseModifier: 'shift', theme: 'light', uiScale: 120,
      });
    }
  });
});
