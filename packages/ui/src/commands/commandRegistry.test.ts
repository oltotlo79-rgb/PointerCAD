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
    clearMeasurement: vi.fn(),
  };
  return { value: { state: () => runtime, actions }, actions };
}

describe('command execution', () => {
  it.each(['part', 'assembly'] as const)('図面用の削除を%sから直接呼んでも実行しない', documentKind => {
    const target = environment({ documentKind });
    expect(executeCommand('drawing.deleteSelection', target.value)).toEqual({ status: 'disabled', commandId: 'drawing.deleteSelection' });
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
    expect(executeCommand('history.undo', target.value)).toEqual({ status: 'disabled', commandId: 'history.undo' });
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
});
