import { describe, expect, it, vi } from 'vitest';
import { executeCommand, type CommandActions, type CommandEnvironment, type CommandRuntimeState } from './commandRegistry.js';

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
