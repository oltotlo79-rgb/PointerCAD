import { createAssemblyDocument, createDrawingDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FACE_REGIONS } from '../viewcube/viewCubeMath.js';
import { executeCommand } from './commandRegistry.js';
import { runViewCommand } from './viewCommandExecution.js';

const state = () => useAppStore.getState();

/** 期待値は製品の定数から作らず書き写す: 命令の名前、要求する面、その面の外向きの軸(ビューキューブの面と同じ)。 */
const ORIENTATION_COMMANDS = [
  ['toolbar.view.front', 'front', { x: 0, y: -1, z: 0 }],
  ['toolbar.view.back', 'back', { x: 0, y: 1, z: 0 }],
  ['toolbar.view.right', 'right', { x: 1, y: 0, z: 0 }],
  ['toolbar.view.left', 'left', { x: -1, y: 0, z: 0 }],
  ['toolbar.view.top', 'top', { x: 0, y: 0, z: 1 }],
  ['toolbar.view.bottom', 'bottom', { x: 0, y: 0, z: -1 }],
] as const;

beforeEach(() => {
  resetTestStore();
  // 文書を作り直しても戻らない表示の要求なので、検査ごとに空へ戻す。
  useAppStore.setState({ viewOrientationRequest: null });
});

describe('標準の向き(正面・背面・右・左・上・下)の命令', () => {
  it.each(ORIENTATION_COMMANDS)('%s は %s の面を 1 回だけ要求し、文書・履歴・ホーム視点の要求は変えない', (id, face, axis) => {
    const document = state().document, home = state().homeViewRequestCount;
    expect(executeCommand(id)).toEqual({ status: 'executed', commandId: id, ready: true, reasonKey: null });
    expect(state().viewOrientationRequest).toEqual({ face, serial: 1 });
    expect(FACE_REGIONS[face]).toEqual(axis);
    expect(state().document).toBe(document);
    expect(state().canUndo).toBe(false);
    expect(state().homeViewRequestCount).toBe(home);
  });

  it('同じ向きを続けて押しても要求は毎回新しくなり、ビューキューブが毎回動ける', () => {
    executeCommand('toolbar.view.top');
    const first = state().viewOrientationRequest;
    executeCommand('toolbar.view.top');
    expect(state().viewOrientationRequest).toEqual({ face: 'top', serial: 2 });
    expect(state().viewOrientationRequest).not.toBe(first);
  });

  it('組立の画面でも同じ面を要求し、図面では理由を返して要求しない', () => {
    state().openAssembly(createAssemblyDocument('組立'));
    expect(executeCommand('toolbar.view.left').status).toBe('executed');
    expect(state().viewOrientationRequest).toEqual({ face: 'left', serial: 1 });
    resetTestStore();
    useAppStore.setState({ viewOrientationRequest: null });
    state().openDrawing(createDrawingDocument('図面', {
      sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
    }));
    expect(executeCommand('toolbar.view.front')).toEqual({
      status: 'disabled', commandId: 'toolbar.view.front', ready: false, reasonKey: 'command.unavailable.document',
    });
    expect(state().viewOrientationRequest).toBeNull();
  });

  it('4 分割で向きの決まった区画(平面・正面・右側面)を選んでいる間は向きを変えず、等角の区画なら移る', () => {
    state().setQuadViewEnabled(true);
    for (const pane of ['top', 'front', 'right'] as const) {
      state().setQuadActivePane(pane);
      expect(runViewCommand('view', 'bottom')).toEqual({ ready: false, reasonKey: 'command.unavailable.action' });
      expect(state().viewOrientationRequest).toBeNull();
    }
    state().setQuadActivePane('isometric');
    expect(runViewCommand('view', 'bottom')).toEqual({ ready: true, reasonKey: null });
    expect(state().viewOrientationRequest).toEqual({ face: 'bottom', serial: 1 });
  });

  it('ホーム視点の命令は今どおり要求の数だけを増やし、向きの要求は出さない', () => {
    const home = state().homeViewRequestCount;
    expect(executeCommand('toolbar.view.home').status).toBe('executed');
    expect(state().homeViewRequestCount).toBe(home + 1);
    expect(state().viewOrientationRequest).toBeNull();
  });
});
