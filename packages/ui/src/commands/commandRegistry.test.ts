import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchCommandKey, executeCommand, type CommandRuntimeState } from './commandRegistry.js';
import { validateShortcutAssignments, type ShortcutAssignments } from './shortcutAssignments.js';

type CommandEnvironment = NonNullable<Parameters<typeof executeCommand>[1]>;
type CommandActions = NonNullable<Parameters<typeof executeCommand>[1]>['actions'];

function environment(overrides: Partial<CommandRuntimeState> = {}): {
  readonly value: CommandEnvironment;
  readonly actions: CommandActions;
} {
  const runtime: CommandRuntimeState = {
    documentKind: 'part', helpOpen: false, canUndo: false, canRedo: false,
    strengthOpen: false, measurementOpen: false, drawingTool: 'select', ...overrides,
  };
  const actions: CommandActions = {
    newFile: vi.fn(), openFile: vi.fn(), saveFile: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    setSelectionKind: vi.fn(), focusCommandLine: vi.fn(), cancelDrawingTool: vi.fn(),
    commitDrawingDimension: vi.fn(), commitDrawingDimensionSeries: vi.fn(),
    deleteDrawingSelection: vi.fn(), openContextualHelp: vi.fn(), closeStrength: vi.fn(),
    clearMeasurement: vi.fn(), commandFeedback: vi.fn(),
  };
  return { value: { state: () => runtime, actions }, actions };
}

describe('command execution', () => {
  it('2点接続の共通判定が不可なら実行せず、可でも実行直前の再検証結果を返す', () => {
    const disabled = environment({ connectPointsReason: 'sketch.connect.samePoint' });
    const connectPoints = vi.fn(() => ({ ready: false as const, reasonKey: 'sketch.connect.unresolved' as const }));
    const disabledEnvironment = { ...disabled.value, actions: { ...disabled.actions, connectPoints } };
    expect(executeCommand('sketch.connectPoints', disabledEnvironment)).toMatchObject({
      status: 'disabled', reasonKey: 'sketch.connect.samePoint',
    });
    expect(connectPoints).not.toHaveBeenCalled();
    const enabled = environment({ connectPointsReason: null });
    expect(executeCommand('sketch.connectPoints', { ...enabled.value, actions: { ...enabled.actions, connectPoints } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.connect.unresolved' });
    expect(connectPoints).toHaveBeenCalledOnce();
    expect(enabled.actions.commandFeedback).toHaveBeenLastCalledWith('sketch.connect.unresolved');
  });
  it('点で面を張る共通判定が不可なら実行せず、可でも実行直前の再検証結果を返す', () => {
    const faceFromPoints = vi.fn(() => ({ ready: false as const, reasonKey: 'sketch.facePoints.notPlanar' as const }));
    const disabled = environment({ faceFromPointsReason: 'sketch.facePoints.collinear' });
    expect(executeCommand('sketch.faceFromPoints', { ...disabled.value, actions: { ...disabled.actions, faceFromPoints } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.facePoints.collinear' });
    expect(faceFromPoints).not.toHaveBeenCalled();
    expect(disabled.actions.commandFeedback).toHaveBeenLastCalledWith('sketch.facePoints.collinear');
    const unknown = environment();
    expect(executeCommand('sketch.faceFromPoints', { ...unknown.value, actions: { ...unknown.actions, faceFromPoints } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.facePoints.selectThree' });
    expect(faceFromPoints).not.toHaveBeenCalled();
    const enabled = environment({ faceFromPointsReason: null });
    expect(executeCommand('sketch.faceFromPoints', { ...enabled.value, actions: { ...enabled.actions, faceFromPoints } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.facePoints.notPlanar' });
    expect(faceFromPoints).toHaveBeenCalledOnce();
    expect(enabled.actions.commandFeedback).toHaveBeenLastCalledWith('sketch.facePoints.notPlanar');
    const created = vi.fn(() => ({ ready: true as const, reasonKey: null }));
    expect(executeCommand('sketch.faceFromPoints', { ...enabled.value, actions: { ...enabled.actions, faceFromPoints: created } }))
      .toEqual({ status: 'executed', commandId: 'sketch.faceFromPoints', ready: true, reasonKey: null });
    const assembly = environment({ documentKind: 'assembly', faceFromPointsReason: null });
    expect(executeCommand('sketch.faceFromPoints', { ...assembly.value, actions: { ...assembly.actions, faceFromPoints: created } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'command.unavailable.document' });
    expect(created).toHaveBeenCalledOnce();
  });
  it('基準点に点を置く共通判定が不可なら実行せず、未判定は1つ選ぶよう案内し、可なら実行直前の再検証結果を返す', () => {
    const pointAtReference = vi.fn(() => ({ ready: false as const, reasonKey: 'sketch.referencePoint.ambiguous' as const }));
    const disabled = environment({ pointAtReferenceReason: 'sketch.referencePoint.unsupported' });
    expect(executeCommand('sketch.pointAtReference', { ...disabled.value, actions: { ...disabled.actions, pointAtReference } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.referencePoint.unsupported' });
    const unknown = environment();
    expect(executeCommand('sketch.pointAtReference', { ...unknown.value, actions: { ...unknown.actions, pointAtReference } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.referencePoint.selectOne' });
    expect(pointAtReference).not.toHaveBeenCalled();
    const enabled = environment({ pointAtReferenceReason: null });
    expect(executeCommand('sketch.pointAtReference', { ...enabled.value, actions: { ...enabled.actions, pointAtReference } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'sketch.referencePoint.ambiguous' });
    expect(enabled.actions.commandFeedback).toHaveBeenLastCalledWith('sketch.referencePoint.ambiguous');
    const created = vi.fn(() => ({ ready: true as const, reasonKey: null }));
    expect(executeCommand('sketch.pointAtReference', { ...enabled.value, actions: { ...enabled.actions, pointAtReference: created } }))
      .toEqual({ status: 'executed', commandId: 'sketch.pointAtReference', ready: true, reasonKey: null });
    const assembly = environment({ documentKind: 'assembly', pointAtReferenceReason: null });
    expect(executeCommand('sketch.pointAtReference', { ...assembly.value, actions: { ...assembly.actions, pointAtReference: created } }))
      .toMatchObject({ status: 'disabled', reasonKey: 'command.unavailable.document' });
    expect(created).toHaveBeenCalledOnce();
  });
  it.each(['part', 'assembly'] as const)('図面用の削除を%sから直接呼んでも実行しない', documentKind => {
    const target = environment({ documentKind });
    expect(executeCommand('drawing.deleteSelection', target.value)).toEqual({ status: 'disabled', commandId: 'drawing.deleteSelection',
      ready: false, reasonKey: 'command.unavailable.document' });
    expect(target.actions.commandFeedback).toHaveBeenCalledWith('command.unavailable.document');
    expect(target.actions.deleteDrawingSelection).not.toHaveBeenCalled();
  });

  it('図面から立体の選択種別とコマンド欄へ直接切り替えない', () => {
    const target = environment({ documentKind: 'drawing' });
    expect(executeCommand('selection.face', target.value).status).toBe('disabled');
    expect(executeCommand('commandLine.focus', target.value).status).toBe('disabled');
    expect(target.actions.setSelectionKind).not.toHaveBeenCalled();
    expect(target.actions.focusCommandLine).not.toHaveBeenCalled();
  });

  it('ヘルプを読んでいる間の直接操作でも文書を変えず、ヘルプは呼べる', () => {
    const target = environment({ helpOpen: true, canUndo: true });
    for (const id of ['file.new', 'file.open', 'file.save', 'history.undo']) {
      expect(executeCommand(id, target.value).status).toBe('disabled');
    }
    expect(target.actions.newFile).not.toHaveBeenCalled();
    expect(target.actions.openFile).not.toHaveBeenCalled();
    expect(target.actions.saveFile).not.toHaveBeenCalled();
    expect(target.actions.undo).not.toHaveBeenCalled();
    expect(executeCommand('help.contextual', target.value).status).toBe('executed');
    expect(target.actions.openContextualHelp).toHaveBeenCalledOnce();
  });

  it('returns unregistered instead of silently dropping an unknown command', () => {
    const target = environment();
    expect(executeCommand('missing.command', target.value)).toEqual({ status: 'unregistered', requestedId: 'missing.command' });
    expect(target.actions.newFile).not.toHaveBeenCalled();
  });

  it('does not execute an unavailable registered command', () => {
    const target = environment({ canUndo: false });
    expect(executeCommand('history.undo', target.value)).toEqual({ status: 'disabled', commandId: 'history.undo',
      ready: false, reasonKey: 'command.unavailable.undo' });
    expect(target.actions.commandFeedback).toHaveBeenCalledWith('command.unavailable.undo');
    expect(target.actions.undo).not.toHaveBeenCalled();
  });

  it('uses the same save and Undo actions as toolbar and keyboard callers', () => {
    const target = environment({ canUndo: true });
    expect(executeCommand('file.saveAs', target.value).status).toBe('executed');
    expect(target.actions.saveFile).toHaveBeenCalledWith(true);
    expect(executeCommand('history.undo', target.value).status).toBe('executed');
    expect(target.actions.undo).toHaveBeenCalledOnce();
  });

  it('routes drawing series Enter without executing the ordinary dimension action', () => {
    const target = environment({ documentKind: 'drawing', drawingTool: 'dimensionSeries' });
    expect(executeCommand('drawing.commitDimension', target.value).status).toBe('executed');
    expect(target.actions.commitDrawingDimensionSeries).toHaveBeenCalledOnce();
    expect(target.actions.commitDrawingDimension).not.toHaveBeenCalled();
  });

  it.each([
    ['history.redo', 'command.unavailable.redo'],
    ['workspace.closeStrength', 'command.unavailable.strength'],
    ['workspace.clearMeasurement', 'command.unavailable.measurement'],
  ])('returns and publishes the specific reason for %s', (id, reasonKey) => {
    const target = environment();
    expect(executeCommand(id, target.value)).toEqual({ status: 'disabled', commandId: id, ready: false, reasonKey });
    expect(target.actions.commandFeedback).toHaveBeenCalledWith(reasonKey);
  });

  it('preserves a complete failure already published by the action while returning disabled', () => {
    const target = environment();
    const toolbarCommand = vi.fn(() => ({ ready: false, reasonKey: 'solidError.needTwoBodies' as const,
      feedback: 'handled' as const }));
    const value = { ...target.value, actions: { ...target.actions, toolbarCommand } };
    expect(executeCommand('toolbar.solidCombine.subtract', value)).toEqual({ status: 'disabled',
      commandId: 'toolbar.solidCombine.subtract', ready: false, reasonKey: 'solidError.needTwoBodies' });
    expect(toolbarCommand).toHaveBeenCalledOnce();
    expect(target.actions.commandFeedback).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('passes through the toolbar refusal and does not report an execution', () => {
    const target = environment({ documentKind: 'assembly' });
    const toolbarCommand = vi.fn(() => ({ ready: false, reasonKey: 'assembly.mate.needTwo' as const }));
    const value = { ...target.value, actions: { ...target.actions, toolbarCommand } };
    expect(executeCommand('toolbar.mate.coincident', value)).toEqual({ status: 'disabled',
      commandId: 'toolbar.mate.coincident', ready: false, reasonKey: 'assembly.mate.needTwo' });
    expect(toolbarCommand).toHaveBeenCalledOnce();
    expect(target.actions.commandFeedback).toHaveBeenLastCalledWith('assembly.mate.needTwo');
  });
});

/** Node に DOM は無いので、判定が読む tagName と closest だけを持つ要素で焦点の場所を表す。 */
class FocusedElement {
  readonly isContentEditable = false;
  constructor(readonly tagName: string, private readonly matches: readonly string[] = []) {}
  closest(selector: string): FocusedElement | null {
    return this.matches.some(part => selector.split(',').map(item => item.trim()).includes(part)) ? this : null;
  }
}

class HomeKeyEvent extends Event implements KeyboardEvent {
  readonly code = '';
  readonly keyCode = 0;
  readonly which = 0;
  readonly charCode = 0;
  readonly location = 0;
  readonly detail = 0;
  readonly view = null;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey = false;
  readonly repeat = false;
  readonly isComposing = false;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;
  constructor(readonly key: string, focused: FocusedElement, handledAlready = false) {
    super('keydown', { cancelable: true });
    Object.defineProperty(this, 'target', { value: focused });
    if (handledAlready) this.preventDefault();
  }
  getModifierState(): boolean { return false; }
  initKeyboardEvent(): never { throw new Error('Use the event constructor'); }
  initUIEvent(): never { throw new Error('Use the event constructor'); }
}

describe('ホーム視点の Home キー(全体のキーの入口)', () => {
  beforeEach(() => {
    vi.stubGlobal('Element', FocusedElement);
    vi.stubGlobal('HTMLElement', FocusedElement);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function homeEnvironment(documentKind: 'part' | 'assembly' = 'part', shortcutAssignments?: ShortcutAssignments) {
    const target = environment({ documentKind, shortcutAssignments });
    const toolbarCommand = vi.fn(() => ({ ready: true as const, reasonKey: null }));
    return { value: { ...target.value, actions: { ...target.actions, toolbarCommand } }, toolbarCommand };
  }

  it.each(['part', 'assembly'] as const)('%sでビューポートの外(ツールバーのボタン・木の行)に焦点があってもホーム視点を実行する', documentKind => {
    for (const focused of [new FocusedElement('BUTTON', ['button']), new FocusedElement('DIV'), new FocusedElement('CANVAS')]) {
      const home = homeEnvironment(documentKind);
      const event = new HomeKeyEvent('Home', focused);
      expect(dispatchCommandKey(event, 'bubble', home.value)).toEqual({ status: 'executed',
        commandId: 'toolbar.view.home', ready: true, reasonKey: null });
      expect(home.toolbarCommand).toHaveBeenCalledExactlyOnceWith('toolbar.view.home');
      expect(event.defaultPrevented).toBe(true);
      expect(dispatchCommandKey(new HomeKeyEvent('Home', focused), 'capture', home.value)).toEqual({ status: 'unmatched' });
      expect(home.toolbarCommand).toHaveBeenCalledOnce();
    }
  });

  it('文字の欄・メニュー・窓の中と、先に欄や一覧が処理した Home は取らない', () => {
    const cases = [
      new HomeKeyEvent('Home', new FocusedElement('INPUT')), new HomeKeyEvent('Home', new FocusedElement('TEXTAREA')),
      new HomeKeyEvent('Home', new FocusedElement('BUTTON', ['button', '.pcad-menu'])),
      new HomeKeyEvent('Home', new FocusedElement('BUTTON', ['button', '.pcad-radial-menu'])),
      new HomeKeyEvent('Home', new FocusedElement('BUTTON', ['button', 'dialog[open]'])),
      new HomeKeyEvent('Home', new FocusedElement('DIV'), true),
    ];
    for (const event of cases) {
      const home = homeEnvironment();
      const prevented = event.defaultPrevented;
      expect(dispatchCommandKey(event, 'bubble', home.value)).toEqual({ status: 'unmatched' });
      expect(home.toolbarCommand).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(prevented);
    }
  });

  it('ホーム視点を別のキーへ割り当てると Home では動かず割り当てたキーで動き、ほかの割当は消えない', () => {
    const proposed = {
      'toolbar.view.home': { key: 'h', primary: false, shift: false, alt: false },
      'toolbar.view.front': { key: 'f2', primary: false, shift: false, alt: false },
      'file.open': { key: 'f3', primary: false, shift: false, alt: false },
    };
    const validation = validateShortcutAssignments(proposed);
    expect(validation).toEqual({ ok: true, assignments: proposed });
    if (!validation.ok) return;
    const home = homeEnvironment('part', validation.assignments);
    expect(dispatchCommandKey(new HomeKeyEvent('Home', new FocusedElement('DIV')), 'bubble', home.value)).toEqual({ status: 'unmatched' });
    expect(home.toolbarCommand).not.toHaveBeenCalled();
    expect(dispatchCommandKey(new HomeKeyEvent('h', new FocusedElement('DIV')), 'bubble', home.value)).toMatchObject({
      status: 'executed', commandId: 'toolbar.view.home' });
    expect(dispatchCommandKey(new HomeKeyEvent('F2', new FocusedElement('DIV')), 'bubble', home.value)).toMatchObject({
      status: 'executed', commandId: 'toolbar.view.front' });
    expect(home.toolbarCommand.mock.calls).toEqual([['toolbar.view.home'], ['toolbar.view.front']]);
    // 割当を外す(null)と、ホーム視点はキーを持たない。
    const removed = validateShortcutAssignments({ 'toolbar.view.home': null });
    if (!removed.ok) throw new Error('removing the Home key must be accepted');
    const none = homeEnvironment('part', removed.assignments);
    expect(dispatchCommandKey(new HomeKeyEvent('Home', new FocusedElement('DIV')), 'bubble', none.value)).toEqual({ status: 'unmatched' });
  });
});
