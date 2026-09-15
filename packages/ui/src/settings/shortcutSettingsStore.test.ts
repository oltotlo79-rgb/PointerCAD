import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { applyShortcutSettings } from './ShortcutSettingsForm.js';
import { currentShortcutAssignments } from './shortcutSettings.js';
import { EMPTY_SHORTCUT_ASSIGNMENTS } from '../commands/shortcutAssignments.js';

beforeEach(resetTestStore);
describe('キー割当の適用は文書・入力・保存先・履歴を変更しない', () => {
  it('実際のストアで設定だけを変更し、文書と現在の入力とUndoをそのまま保つ', () => {
    useAppStore.setState({ document: partWithPoint() });
    const before = useAppStore.getState();
    const proposed = { 'history.undo': { key: 'f2', primary: false, shift: false, alt: false } } as const;
    expect(applyShortcutSettings(proposed, currentShortcutAssignments(before.displaySettings))).toBe(true);
    const after = useAppStore.getState();
    expect(after).toEqual({ ...before, displaySettings: { ...before.displaySettings, shortcutAssignments: proposed } });
    expect(after.document).toBe(before.document);
  });
  it('別の割当変更と衝突した古い編集や、固定キーの変更はストアを書き換えない', () => {
    const proposed = { 'history.undo': { key: 'f2', primary: false, shift: false, alt: false } } as const;
    expect(applyShortcutSettings(proposed, EMPTY_SHORTCUT_ASSIGNMENTS)).toBe(true);
    const before = useAppStore.getState();
    expect(applyShortcutSettings({}, EMPTY_SHORTCUT_ASSIGNMENTS)).toBe(false);
    expect(useAppStore.getState()).toBe(before);
    expect(applyShortcutSettings({ 'file.save': null }, currentShortcutAssignments(before.displaySettings))).toBe(false);
    expect(useAppStore.getState()).toBe(before);
  });
});
