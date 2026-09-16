import { describe, expect, it } from 'vitest';
import { type CommandKeyContext, type CommandKeyInput } from './commandDefinitions.js';
import { readShortcutAssignments, resolveAssignedShortcut, validateShortcutAssignments, type AssignedChord } from './shortcutAssignments.js';

const chord = (key: string, extra: Partial<AssignedChord> = {}): AssignedChord => ({ key, primary: true, alt: false, shift: false, ...extra });
const context: CommandKeyContext = { documentKind: 'part', phase: 'bubble', helpOpen: false, textEntry: false,
  composing: false, activatedBySpace: false, insideMenu: false, insideDialog: false };
const input = (key: string, extra: Partial<CommandKeyInput> = {}): CommandKeyInput => ({
  key, ctrl: true, meta: false, alt: false, shift: false, repeat: false, ...extra,
});
describe('保存したキー割当の実行と保護', () => {
  it('割当変更とJSON往復の後は新しいキーだけが同じ操作を呼ぶ', () => {
    const result = validateShortcutAssignments({ 'file.open': chord('k', { shift: true }) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('valid assignment was rejected');
    const restored = readShortcutAssignments(JSON.stringify(result.assignments));
    expect(resolveAssignedShortcut(input('k', { shift: true }), context, restored, () => true)?.commandId).toBe('file.open');
    expect(resolveAssignedShortcut(input('o'), context, restored, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('k', { ctrl: false, meta: true, shift: true }), context, restored, () => true)?.commandId).toBe('file.open');
  });
  it('割当を外すと以前のキーに戻らず、空の設定へ戻した時だけ既定に復元する', () => {
    expect(resolveAssignedShortcut(input('o'), context, { 'file.open': null }, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('o'), context, {}, () => true)?.commandId).toBe('file.open');
  });
  it('同時交換は許可し、片側だけの重複や保存キーの横取りは断る', () => {
    expect(validateShortcutAssignments({ 'file.open': chord('n'), 'file.new': chord('o') }).ok).toBe(true);
    expect(validateShortcutAssignments({ 'file.open': chord('n') })).toMatchObject({ ok: false, problem: { kind: 'conflict', otherCommandId: 'file.new' } });
    expect(validateShortcutAssignments({ 'file.open': chord('s') })).toMatchObject({ ok: false, problem: { kind: 'conflict', otherCommandId: 'file.save' } });
  });
  it.each([chord('w'), chord('r'), chord('f4', { primary: false, alt: true }), chord('f5', { primary: false }),
    chord('k', { alt: true }), chord('n', { shift: true })])('閉じる・再読込・OS用のキーを横取りしない: %j', value => {
    expect(validateShortcutAssignments({ 'file.open': value })).toMatchObject({ ok: false, problem: { kind: 'reserved' } });
  });
  it('F1・保存・取消は設定から無効化しない', () => {
    for (const id of ['help.contextual', 'file.save', 'drawing.cancelTool']) {
      expect(validateShortcutAssignments({ [id]: null })).toMatchObject({ ok: false, problem: { kind: 'fixed-command' } });
    }
  });
  it('元に戻す割当を変えても入力欄の文字や日本語変換を妨げず、無効操作を呼ばない', () => {
    const assignments = { 'history.undo': chord('u') } as const;
    expect(resolveAssignedShortcut(input('u'), context, assignments, () => true)?.commandId).toBe('history.undo');
    expect(resolveAssignedShortcut(input('u'), { ...context, textEntry: true }, assignments, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('u'), { ...context, composing: true }, assignments, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('u'), context, assignments, definition => definition.id !== 'history.undo')).toBeNull();
    expect(resolveAssignedShortcut(input('s'), { ...context, textEntry: true, composing: true }, assignments, () => true)?.commandId).toBe('file.save');
  });
  it('Altを付けた割当はAltなしで誤発火しない', () => {
    const assignments = { 'selection.face': chord('k', { primary: false, alt: true }) } as const;
    expect(validateShortcutAssignments(assignments).ok).toBe(true);
    expect(resolveAssignedShortcut(input('k', { ctrl: false, alt: true }), context, assignments, () => true)?.commandId).toBe('selection.face');
    expect(resolveAssignedShortcut(input('k', { ctrl: false }), context, assignments, () => true)).toBeNull();
  });
  it('ファイル操作を英字だけへ変更しても入力欄の文字を横取りしない', () => {
    const assignments = { 'file.open': chord('k', { primary: false }) } as const;
    expect(validateShortcutAssignments(assignments).ok).toBe(true);
    expect(resolveAssignedShortcut(input('k', { ctrl: false }), context, assignments, () => true)?.commandId).toBe('file.open');
    expect(resolveAssignedShortcut(input('k', { ctrl: false }), { ...context, textEntry: true }, assignments, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('k', { ctrl: false }), { ...context, composing: true }, assignments, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('k', { ctrl: false }), { ...context, insideDialog: true }, assignments, () => true)).toBeNull();
    expect(resolveAssignedShortcut(input('k', { ctrl: false }), { ...context, insideMenu: true }, assignments, () => true)).toBeNull();
  });
  it('壊れた値、未知の操作、余分な項目、大きすぎる保存内容を部分採用しない', () => {
    for (const value of [null, [], { unknown: chord('k') }, { 'file.open': { ...chord('k'), extra: true } },
      { 'file.open': chord('k'), 'file.new': { ...chord('u'), primary: 'true' } }]) {
      expect(validateShortcutAssignments(value).ok).toBe(false);
      expect(readShortcutAssignments(JSON.stringify(value))).toEqual({});
    }
    expect(readShortcutAssignments('{')).toEqual({});
    expect(readShortcutAssignments(' '.repeat(32_769))).toEqual({});
  });
});
