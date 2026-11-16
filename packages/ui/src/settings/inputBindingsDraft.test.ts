import { describe, expect, it } from 'vitest';
import { COMMAND_DEFINITIONS, type CommandId } from '../commands/commandDefinitions.js';
import { shortcutConflicts, validateShortcutAssignments, type AssignedChord, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import {
  adjacentRow, conflictsOfCommand, filterKeyBindingRows, keyBindingRows, placeViewTrigger, restoreCommand, restoreViewAction,
  swapViewTrigger, swapWithOther, takeFromOther, takeViewTrigger, viewKeyCollisions, viewTriggerOwner,
} from './inputBindingsDraft.js';
import { DEFAULT_VIEW_CONTROLS, viewControlProblems, type ViewTrigger } from './viewControlSettings.js';

/* 設計 1-4・§7.1: 入れ替え・あちらを外す・操作ごとの既定に戻す・衝突の一覧。キーの表が全ての命令の行を持つ。 */
const key = (letter: string, extra: Partial<AssignedChord> = {}): AssignedChord => ({ key: letter, primary: false, alt: false, shift: false, ...extra });
const ctrl = (letter: string): AssignedChord => key(letter, { primary: true });
const OFF = { alt: false, shift: false, ctrl: false, meta: false };
const drag = (button: 'left' | 'middle' | 'right', extra: Partial<typeof OFF> = {}): ViewTrigger => ({ kind: 'drag', button, ...OFF, ...extra });
const wheel = (extra: Partial<typeof OFF> = {}): ViewTrigger => ({ kind: 'wheel', ...OFF, ...extra });
const name = (id: CommandId): string => id;

describe('キーの表の行と衝突', () => {
  it('全ての命令の行を、今の下書きで効くキーと固定の印で持つ', () => {
    const rows = keyBindingRows({}, []);
    expect(rows.map(row => row.id)).toEqual(COMMAND_DEFINITIONS.map(definition => definition.id));
    expect(rows.find(row => row.id === 'file.open')).toEqual({ id: 'file.open', keys: ['Ctrl/Cmd+O'], fixed: false, conflict: false });
    expect(rows.find(row => row.id === 'file.save')?.fixed).toBe(true);
    expect(keyBindingRows({ 'file.open': null }, []).find(row => row.id === 'file.open')?.keys).toEqual([]);
    expect(keyBindingRows({ 'history.undo': [key('f2')] }, []).find(row => row.id === 'history.undo')?.keys).toEqual(['F2']);
  });

  it('2 つの命令が同じキーなら両方の行に衝突の印を付け、相手の名前と組を返す', () => {
    const values: ShortcutAssignments = { 'history.undo': [key('f2')], 'history.redo': [key('f2')] };
    const conflicts = shortcutConflicts(values);
    expect(validateShortcutAssignments(values).ok).toBe(false);
    const rows = keyBindingRows(values, conflicts);
    expect(rows.filter(row => row.conflict).map(row => row.id).sort()).toEqual(['history.redo', 'history.undo']);
    expect(conflictsOfCommand(conflicts, 'history.undo')).toEqual([{ other: 'history.redo', chord: 'F2' }]);
    expect(conflictsOfCommand(conflicts, 'file.open')).toEqual([]);
  });

  it('↑↓ は表示している行の中で前後へ移り、端では止まる(B-06)', () => {
    const rows = keyBindingRows({}, []).slice(0, 3), ids = rows.map(row => row.id);
    expect(adjacentRow(rows, ids[0], 1)).toBe(ids[1]);
    expect(adjacentRow(rows, ids[1], -1)).toBe(ids[0]);
    expect(adjacentRow(rows, ids[2], 1)).toBeNull();
    expect(adjacentRow(rows, ids[0], -1)).toBeNull();
    // 選んでいた行が絞り込みで見えなくなった時は、最初の行へ移る。
    expect(adjacentRow(rows.slice(1), ids[0], 1)).toBe(ids[1]);
    expect(adjacentRow([], ids[0], 1)).toBeNull();
  });

  it('名前・押したキー・衝突と未割当だけ、で絞る', () => {
    const values: ShortcutAssignments = { 'history.undo': [key('f2')], 'history.redo': [key('f2')], 'file.new': null };
    const rows = keyBindingRows(values, shortcutConflicts(values));
    const filter = { name, query: '', usingKey: null, problemsOnly: false };
    expect(filterKeyBindingRows(rows, { ...filter, query: 'history.redo' }).map(row => row.id)).toEqual(['history.redo']);
    expect(filterKeyBindingRows(rows, { ...filter, usingKey: ['file.open'] }).map(row => row.id)).toEqual(['file.open']);
    const problems = filterKeyBindingRows(rows, { ...filter, problemsOnly: true }).map(row => row.id);
    expect(problems).toContain('history.undo'); expect(problems).toContain('file.new'); expect(problems).not.toContain('file.open');
  });
});

describe('入れ替える・あちらを外して使う・この操作だけ既定に戻す(キー)', () => {
  it('あちらを外す: 既定のままの相手は割当なしにし、衝突が消える', () => {
    const values: ShortcutAssignments = { 'file.open': [ctrl('n')] };
    expect(shortcutConflicts(values).map(conflict => conflict.otherCommandId)).toContain('file.new');
    const next = takeFromOther(values, 'file.new', ctrl('n'));
    expect(next).toEqual({ 'file.open': [ctrl('n')], 'file.new': null });
    expect(shortcutConflicts(next)).toEqual([]);
    expect(validateShortcutAssignments(next).ok).toBe(true);
  });
  it('あちらを外す: 相手の 2 つの組のうち、ぶつかる組だけを外す。固定の命令は変えない', () => {
    const values: ShortcutAssignments = { 'history.undo': [key('f2')], 'history.redo': [key('f2'), key('f3')] };
    expect(takeFromOther(values, 'history.redo', key('f2'))).toEqual({ 'history.undo': [key('f2')], 'history.redo': [key('f3')] });
    expect(takeFromOther(values, 'file.save', ctrl('s'))).toBe(values);
  });
  it('入れ替える: 相手に、こちらが前に使っていた組を渡す。前の組が無ければ外すのと同じ', () => {
    const previous: ShortcutAssignments = { 'history.undo': [key('f2')], 'history.redo': [key('f3')] };
    const values: ShortcutAssignments = { 'history.undo': [key('f3')], 'history.redo': [key('f3')] };
    const swapped = swapWithOther(values, previous, 'history.undo', 'history.redo', key('f3'));
    expect(swapped).toEqual({ 'history.undo': [key('f3')], 'history.redo': [key('f2')] });
    expect(validateShortcutAssignments(swapped).ok).toBe(true);
    expect(swapWithOther({ 'file.open': [ctrl('n')] }, {}, 'file.open', 'file.new', ctrl('n'))).toEqual({ 'file.open': [ctrl('n')], 'file.new': null });
  });
  it('この操作だけ既定に戻す: その命令の割当だけを消す', () => {
    expect(restoreCommand({ 'history.undo': [key('f2')], 'file.new': null }, 'history.undo')).toEqual({ 'file.new': null });
  });
});

describe('視点のキーと命令のキーの重なり(B-08、設計 §5 の key-collision)', () => {
  const keys = (group: 'arrows' | 'numpad' | 'plusMinus', extra: Partial<typeof OFF> = {}): ViewTrigger => ({ kind: 'keys', keys: group, ...OFF, ...extra });
  const withOrbitKeys = (trigger: ViewTrigger) => ({ ...DEFAULT_VIEW_CONTROLS,
    bindings: { ...DEFAULT_VIEW_CONTROLS.bindings, orbit: [...DEFAULT_VIEW_CONTROLS.bindings.orbit, trigger] } });
  const arrowUp = { code: 'ArrowUp', label: '↑', primary: false, shift: false, alt: false } as const;
  it('同じ修飾キーの矢印を命令に割り当てていれば重なり、修飾キーが違えば重ならない', () => {
    expect(viewKeyCollisions(withOrbitKeys(keys('arrows')), { 'history.undo': [arrowUp] }))
      .toEqual([{ action: 'orbit', trigger: keys('arrows'), commandId: 'history.undo' }]);
    expect(viewKeyCollisions(withOrbitKeys(keys('arrows', { shift: true })), { 'history.undo': [arrowUp] })).toEqual([]);
    expect(viewKeyCollisions(DEFAULT_VIEW_CONTROLS, { 'history.undo': [arrowUp] })).toEqual([]);
  });
  it('NumLock の入ったテンキーの数字は、同じ数字の既定のキー(選択の種類の 1〜4)とも重なる', () => {
    const collisions = viewKeyCollisions(withOrbitKeys(keys('numpad')), {});
    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions.every(item => item.action === 'orbit' && item.commandId.startsWith('selection.'))).toBe(true);
  });
});

describe('視点の操作の入れ替え・あちらを外す・既定に戻す', () => {
  it('入力を使っている操作を返す(こちらの操作は数えない)', () => {
    expect(viewTriggerOwner(DEFAULT_VIEW_CONTROLS, drag('middle', { shift: true }))).toBe('pan');
    expect(viewTriggerOwner(DEFAULT_VIEW_CONTROLS, drag('middle', { shift: true }), 'pan')).toBeNull();
    expect(viewTriggerOwner(DEFAULT_VIEW_CONTROLS, wheel({ shift: true }))).toBeNull();
  });
  it('空いている入力は置く・足す', () => {
    const replaced = placeViewTrigger(DEFAULT_VIEW_CONTROLS, 'orbit', 1, wheel({ shift: true }));
    expect(replaced.bindings.orbit).toEqual([drag('middle'), wheel({ shift: true })]);
    const added = placeViewTrigger(DEFAULT_VIEW_CONTROLS, 'orbit', 2, wheel({ shift: true }));
    expect(added.bindings.orbit).toEqual([drag('middle'), drag('left', { alt: true }), wheel({ shift: true })]);
    expect(viewControlProblems(added)).toEqual([]);
  });
  it('あちらを外して使う: 相手から外して、こちらへ置く', () => {
    const next = takeViewTrigger(DEFAULT_VIEW_CONTROLS, 'orbit', 0, drag('middle', { shift: true }));
    expect(next.bindings.orbit).toEqual([drag('middle', { shift: true }), drag('left', { alt: true })]);
    expect(next.bindings.pan).toEqual([drag('right')]);
    expect(viewControlProblems(next)).toEqual([]);
  });
  it('入れ替える: 相手のその入力の場所へ、こちらの前の入力を渡す', () => {
    const next = swapViewTrigger(DEFAULT_VIEW_CONTROLS, 'orbit', 0, drag('middle', { shift: true }));
    expect(next.bindings.orbit).toEqual([drag('middle', { shift: true }), drag('left', { alt: true })]);
    expect(next.bindings.pan).toEqual([drag('right'), drag('middle')]);
    expect(viewControlProblems(next)).toEqual([]);
    // 足す時(前の入力が無い)は、あちらを外すのと同じ。
    expect(swapViewTrigger(DEFAULT_VIEW_CONTROLS, 'zoom', 2, drag('right'))).toEqual(takeViewTrigger(DEFAULT_VIEW_CONTROLS, 'zoom', 2, drag('right')));
  });
  it('この操作だけ既定に戻す(ほかの操作と速さはそのまま)', () => {
    const tuned = { ...DEFAULT_VIEW_CONTROLS, options: { ...DEFAULT_VIEW_CONTROLS.options, orbitSensitivity: 2 },
      bindings: { ...DEFAULT_VIEW_CONTROLS.bindings, pan: [drag('right')], zoom: [wheel()] } };
    const restored = restoreViewAction(tuned, 'zoom');
    expect(restored.bindings.zoom).toEqual([wheel(), wheel({ ctrl: true })]);
    expect(restored.bindings.pan).toEqual([drag('right')]);
    expect(restored.options.orbitSensitivity).toBe(2);
  });
});
