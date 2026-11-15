import { describe, expect, it } from 'vitest';
import { EMPTY_SHORTCUT_ASSIGNMENTS, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings, saveSettings, type SettingsStorage } from './settings.js';
import { currentShortcutAssignments, prepareShortcutSettings } from './shortcutSettings.js';

const openOnF2: ShortcutAssignments = { 'file.open': { key: 'f2', primary: false, shift: false, alt: false } };
function storageFor(value: unknown): SettingsStorage & { readonly values: Map<string, string> } {
  const values = new Map([['pointercad.settings', JSON.stringify(value)]]);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe('キー割当は同じ端末設定へ保存し、他の設定と競合中の変更を保つ', () => {
  it('旧設定の参照は安定し、旧テーマ・倍率・長さ単位を保つ', () => {
    const legacy = { theme: 'light', uiScale: 125, lengthUnit: 'inch' };
    const settings = loadSettings(storageFor(legacy));
    expect(settings).toMatchObject(legacy);
    expect(currentShortcutAssignments(settings)).toBe(EMPTY_SHORTCUT_ASSIGNMENTS);
    expect(currentShortcutAssignments(settings)).toBe(currentShortcutAssignments(settings));
  });
  it('再読込で割当と割当なしが残り、保存先のキーは増えない', () => {
    const storage = storageFor(DEFAULT_DISPLAY_SETTINGS);
    const assignments = { ...openOnF2, 'file.new': null };
    const settings = { ...DEFAULT_DISPLAY_SETTINGS, shortcutAssignments: assignments };
    saveSettings(settings, storage);
    expect([...storage.values.keys()]).toEqual(['pointercad.settings']);
    expect(currentShortcutAssignments(loadSettings(storage))).toEqual({ 'file.open': [openOnF2['file.open']], 'file.new': null });
  });
  it.each([
    { 'file.open': { key: 'f1', primary: false, shift: false, alt: false } },
    { 'unknown.command': null }, null, [],
  ])('読めない割当だけを外し、その他の設定を保つ: %j', shortcutAssignments => {
    const settings = loadSettings(storageFor({ ...DEFAULT_DISPLAY_SETTINGS, theme: 'modern', uiScale: 150, shortcutAssignments }));
    expect(currentShortcutAssignments(settings)).toBe(EMPTY_SHORTCUT_ASSIGNMENTS);
    expect(settings).toMatchObject({ theme: 'modern', uiScale: 150 });
  });
  it('入力中のテーマや初期値変更を保ったまま、キー割当だけを一度で適用する', () => {
    const current = { ...DEFAULT_DISPLAY_SETTINGS, theme: 'light' as const, numericToolDefaults: { 'circle/radius': '12.5' } };
    const next = prepareShortcutSettings(current, currentShortcutAssignments(current), openOnF2);
    expect(next).toEqual({ ...current, shortcutAssignments: { 'file.open': [openOnF2['file.open']] } });
    expect(currentShortcutAssignments(current)).toBe(EMPTY_SHORTCUT_ASSIGNMENTS);
  });
  it('別の割当へ変わった後には古い編集で上書きせず、無効な部分も保存しない', () => {
    const current = { ...DEFAULT_DISPLAY_SETTINGS, shortcutAssignments: openOnF2 };
    expect(prepareShortcutSettings(current, EMPTY_SHORTCUT_ASSIGNMENTS, {})).toBeNull();
    expect(prepareShortcutSettings(current, openOnF2, { ...openOnF2, 'file.save': null })).toBeNull();
    expect(current.shortcutAssignments).toBe(openOnF2);
  });
});

const lineOnL = { key: 'l', primary: false, shift: false, alt: false };
describe('v1 の割当から新しい形への移行(設計 R6・§4.1 案 A)', () => {
  it('v1 の割当を 1 件ずつ移し、知らない命令名の 1 件だけ外して数を知らせ、保存しても v1 の欄は保存されていたまま残す', () => {
    const legacy = { 'toolbar.sketch.line': lineOnL, 'toolbar.old.removed': { key: 'q', primary: false, shift: false, alt: false } };
    const storage = storageFor({ ...DEFAULT_DISPLAY_SETTINGS, shortcutAssignments: legacy });
    const loaded = loadSettings(storage);
    expect(currentShortcutAssignments(loaded)).toEqual({ 'toolbar.sketch.line': [lineOnL] });
    expect(loaded.shortcutAssignmentsRecovered).toBe(1);
    saveSettings(loaded, storage);
    const written: unknown = JSON.parse(storage.values.get('pointercad.settings') ?? 'null');
    expect(written).toMatchObject({ shortcutAssignments: legacy, inputAssignments: { version: 2, keys: { 'toolbar.sketch.line': [lineOnL] } } });
    expect(written).not.toHaveProperty('shortcutAssignmentsRecovered');
    const reloaded = loadSettings(storage);
    expect(currentShortcutAssignments(reloaded)).toEqual({ 'toolbar.sketch.line': [lineOnL] });
    expect(reloaded.shortcutAssignmentsRecovered).toBeUndefined();
  });
  it('新しい形があれば v1 より先に読み、読めない新しい形(未来の版)は v1 から移し直して知らせる', () => {
    const both = storageFor({ ...DEFAULT_DISPLAY_SETTINGS, shortcutAssignments: openOnF2,
      inputAssignments: { version: 2, keys: { 'toolbar.sketch.line': [lineOnL], 'file.new': null } } });
    expect(currentShortcutAssignments(loadSettings(both))).toEqual({ 'toolbar.sketch.line': [lineOnL], 'file.new': null });
    const future = loadSettings(storageFor({ ...DEFAULT_DISPLAY_SETTINGS, shortcutAssignments: openOnF2,
      inputAssignments: { version: 3, keys: {} } }));
    expect(currentShortcutAssignments(future)).toEqual({ 'file.open': [openOnF2['file.open']] });
    expect(future.shortcutAssignmentsRecovered).toBe(1);
  });
  it('割当を適用すると、読めなかった数のお知らせは消える', () => {
    const current = { ...DEFAULT_DISPLAY_SETTINGS, shortcutAssignmentsRecovered: 2 };
    expect(prepareShortcutSettings(current, currentShortcutAssignments(current), openOnF2)?.shortcutAssignmentsRecovered).toBeUndefined();
  });
});
