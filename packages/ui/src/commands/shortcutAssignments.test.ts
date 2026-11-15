import { describe, expect, it } from 'vitest';
import { type CommandKeyContext, type CommandKeyInput } from './commandDefinitions.js';
import { commandDefinition } from './commandDefinitions.js';
import { currentCommandLabel } from './commandLabels.js';
import type { CodeChord } from './commandInputSettings.js';
import {
  effectiveBindings, readShortcutAssignments, resolveAssignedShortcut, salvageShortcutAssignments, validateShortcutAssignments,
  type AssignedChord,
} from './shortcutAssignments.js';

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

const plain = (key: string, extra: Partial<AssignedChord> = {}): AssignedChord => ({ key, primary: false, alt: false, shift: false, ...extra });
const place = (code: string, label: string, extra: Partial<Omit<CodeChord, 'code' | 'label'>> = {}): CodeChord =>
  ({ code, label, primary: false, shift: false, alt: false, ...extra }) as CodeChord;
const press = (key: string, code: string, extra: Partial<CommandKeyInput> = {}): CommandKeyInput => ({
  key, code, ctrl: false, meta: false, alt: false, shift: false, repeat: false, ...extra,
});

describe('キーの種類の拡張と 1 命令 2 つまで(設計 1-3)', () => {
  it('1 つの命令に 2 つまで割り当てられ、どちらのキーでも動き、3 つ目と同じ組の重ねは断る', () => {
    const result = validateShortcutAssignments({ 'file.open': [plain('f2'), place('ArrowUp', 'ArrowUp', { shift: true })] });
    expect(result).toEqual({ ok: true, assignments: { 'file.open': [plain('f2'), place('ArrowUp', 'ArrowUp', { shift: true })] } });
    if (!result.ok) return;
    expect(resolveAssignedShortcut(press('F2', 'F2'), context, result.assignments, () => true)?.commandId).toBe('file.open');
    expect(resolveAssignedShortcut(press('ArrowUp', 'ArrowUp', { shift: true }), context, result.assignments, () => true)?.commandId).toBe('file.open');
    expect(resolveAssignedShortcut(press('ArrowUp', 'ArrowUp'), context, result.assignments, () => true)).toBeNull();
    expect(currentCommandLabel('file.open', result.assignments, 'part')).toBe('開く (F2 / Shift+↑)');
    expect(validateShortcutAssignments({ 'file.open': [plain('f2'), plain('f3'), plain('f4')] }))
      .toEqual({ ok: false, problem: { kind: 'too-many-chords', commandId: 'file.open' } });
    expect(validateShortcutAssignments({ 'file.open': [plain('f2'), plain('f2')] })).toEqual({ ok: false, problem: { kind: 'invalid' } });
    expect(validateShortcutAssignments({ 'file.open': [] })).toEqual({ ok: false, problem: { kind: 'invalid' } });
  });

  it('位置の組は物理の位置だけで合わせる(NumLock を切ったテンキー 8 は Numpad8 の組だけに当たる)', () => {
    const result = validateShortcutAssignments({ 'toolbar.view.top': place('Numpad8', 'ArrowUp') });
    if (!result.ok) throw new Error('numpad assignment was rejected');
    const top = (input: CommandKeyInput) => resolveAssignedShortcut(input, context, result.assignments, () => true)?.commandId ?? null;
    expect(top(press('ArrowUp', 'Numpad8'))).toBe('toolbar.view.top');
    expect(top(press('8', 'Numpad8'))).toBe('toolbar.view.top');
    expect(top(press('ArrowUp', 'ArrowUp'))).toBeNull();
    expect(top(press('8', 'Digit8'))).toBeNull();
    // テンキーの 1 は選択の種類の既定 1 と別の位置なので、どちらも残る。
    const numpadOne = validateShortcutAssignments({ 'toolbar.view.front': place('Numpad1', '1') });
    if (!numpadOne.ok) throw new Error('numpad 1 must not collide with the default 1');
    expect(resolveAssignedShortcut(press('1', 'Numpad1'), context, numpadOne.assignments, () => true)?.commandId).toBe('toolbar.view.front');
    expect(resolveAssignedShortcut(press('1', 'Digit1'), context, numpadOne.assignments, () => true)?.commandId).toBe('selection.vertex');
  });

  it('断るキー(Ctrl/Alt＋Space・Ctrl＋PageUp/PageDown・Ctrl＋Shift＋Delete)と、固定の命令のキーとの重ねを断る', () => {
    for (const reserved of [place('Space', ' ', { primary: true }), place('Space', ' ', { alt: true }),
      place('Space', ' ', { primary: true, shift: true }), place('PageUp', 'PageUp', { primary: true }),
      place('PageDown', 'PageDown', { primary: true }), place('Delete', 'Delete', { primary: true, shift: true })]) {
      expect(validateShortcutAssignments({ 'file.open': reserved })).toMatchObject({ ok: false, problem: { kind: 'reserved' } });
    }
    expect(validateShortcutAssignments({ 'file.open': place('Space', ' ') }))
      .toEqual({ ok: false, problem: { kind: 'conflict', commandId: 'file.open', otherCommandId: 'commandLine.focus' } });
    expect(validateShortcutAssignments({ 'toolbar.view.grid': plain('1'), 'toolbar.view.top': place('Numpad1', '1') }))
      .toMatchObject({ ok: false, problem: { kind: 'conflict' } });
  });

  it('例 5: 知らない命令名の 1 件だけ捨て、ほかの割当を残して捨てた数を返す', () => {
    expect(salvageShortcutAssignments({
      'toolbar.sketch.line': { key: 'l', primary: false, shift: false, alt: false },
      'toolbar.old.removed': { key: 'q', primary: false, shift: false, alt: false },
    })).toEqual({ assignments: { 'toolbar.sketch.line': [plain('l')] }, dropped: 1 });
  });

  it('救い出しは固定の命令・断るキー・3 つ目・先の割当と同じ組・固定の命令の既定と同じ組を 1 件ずつ捨てる', () => {
    expect(salvageShortcutAssignments({
      'file.save': null,
      'file.open': [plain('f2'), plain('f3'), plain('f4')],
      'file.new': plain('f2'),
      'toolbar.view.grid': [plain('f5'), plain('g')],
      'toolbar.view.snap': place('Space', ' '),
      'history.undo': null,
    })).toEqual({ assignments: { 'file.open': [plain('f2'), plain('f3')], 'toolbar.view.grid': [plain('g')], 'history.undo': null }, dropped: 5 });
    expect(salvageShortcutAssignments('broken')).toEqual({ assignments: {}, dropped: 1 });
    expect(salvageShortcutAssignments(undefined)).toEqual({ assignments: {}, dropped: 0 });
  });

  it('例 6: 保存済みの割当とほかの命令の既定が重なったら利用者の割当が勝ち、既定は使わない(新しく選ぶ時は今どおり断る)', () => {
    const stored = salvageShortcutAssignments({ 'toolbar.sketch.line': place('Home', 'Home') });
    expect(stored).toEqual({ assignments: { 'toolbar.sketch.line': [place('Home', 'Home')] }, dropped: 0 });
    const home = commandDefinition('toolbar.view.home');
    if (home === null) throw new Error('home command missing');
    expect(effectiveBindings(home, stored.assignments)).toEqual([]);
    expect(currentCommandLabel('toolbar.view.home', stored.assignments, 'part')).toBe('ホーム視点');
    expect(resolveAssignedShortcut(press('Home', 'Home', { ctrl: false }), context, stored.assignments, () => true)?.commandId)
      .toBe('toolbar.sketch.line');
    expect(validateShortcutAssignments(stored.assignments, stored.assignments).ok).toBe(true);
    expect(validateShortcutAssignments(stored.assignments))
      .toEqual({ ok: false, problem: { kind: 'conflict', commandId: 'toolbar.sketch.line', otherCommandId: 'toolbar.view.home' } });
  });
});
