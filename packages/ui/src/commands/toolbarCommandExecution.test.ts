import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssemblyDocument, createDrawingDocument } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { DRAWING_DIMENSION_KINDS } from '../drawing/drawingToolbarItems.js';
import { executeCommand } from './commandRegistry.js';
import { toolbarCommandId } from './toolbarCommandCatalog.js';
import { resolveAssignedShortcut, validateShortcutAssignments } from './shortcutAssignments.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);
const state = () => useAppStore.getState();
const run = (id: string) => executeCommand(id);

function openDrawing(): void {
  state().openDrawing(createDrawingDocument('キーから操作する図面', {
    sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '',
  }));
}

describe('ボタンと割当キーは同じ文書と入力へ接続する', () => {
  it('図形の新しい割当キーで同じ入力段を開き、再度押すと取り消す', () => {
    const assignments = validateShortcutAssignments({ 'toolbar.shape.circle': { key: 'f2', primary: false, shift: false, alt: false } });
    expect(assignments.ok).toBe(true); if (!assignments.ok) return;
    const resolved = resolveAssignedShortcut({ key: 'f2', ctrl: false, meta: false, shift: false, alt: false, repeat: false },
      { documentKind: 'part', phase: 'bubble', helpOpen: false, textEntry: false, composing: false,
        activatedBySpace: false, insideMenu: false, insideDialog: false }, assignments.assignments, () => true);
    expect(resolved?.commandId).toBe('toolbar.shape.circle');
    const original = state().document;
    expect(run(resolved?.commandId ?? '').status).toBe('executed');
    expect(state().numericInput?.step).toBe('circleCenter');
    expect(state().activeTool).toBe('circle');
    expect(state().document).toBe(original); expect(state().canUndo).toBe(false);
    run('toolbar.shape.circle');
    expect(state().activeTool).toBe('select'); expect(state().numericInput).toBeNull();
  });

  it('対象をまだ選んでいない押し出しは、形を作らず対象選択の道具へ切り替える', () => {
    const original = state().document;
    expect(run('toolbar.solidCreate.extrude').status).toBe('executed');
    expect(state().activeTool).toBe('extrude'); expect(state().solidErrorKey).not.toBeNull();
    expect(state().numericInput).toBeNull(); expect(state().document).toBe(original);
    expect(state().canUndo).toBe(false);
  });

  it('和差積は選択不足なら文書も履歴も作らず、理由を残す', () => {
    const original = state().document;
    expect(run('toolbar.solidCombine.union').status).toBe('disabled');
    expect(state().document).toBe(original); expect(state().canUndo).toBe(false);
    expect(state().solidErrorKey).not.toBeNull();
  });

  it('拘束を先に選ぶ操作と同じ拘束の取消を保つ', () => {
    const original = state().document;
    run('toolbar.constraint.horizontal');
    expect(state().activeConstraintKind).toBe('horizontal');
    run('toolbar.constraint.horizontal');
    expect(state().activeConstraintKind).toBeNull(); expect(state().document).toBe(original);
  });

  it('板金の同じ道具を再び押すと取消し、文書を保持する', () => {
    const original = state().document;
    run('toolbar.sheetMetal.sheetBase'); expect(state().sheetMetalTool?.kind).toBe('sheetBase');
    run('toolbar.sheetMetal.sheetBase'); expect(state().sheetMetalTool).toBeNull();
    expect(state().document).toBe(original); expect(state().canUndo).toBe(false);
  });

  it('異なる画面の操作をキーから呼んでも文書と選択を変更しない', () => {
    state().openAssembly(createAssemblyDocument('組立'));
    const before = state();
    for (const id of ['toolbar.shape.circle', 'toolbar.sheetMetal.sheetBase', 'toolbar.drawing.note', 'toolbar.look.appearance']) {
      expect(run(id).status).toBe('disabled'); expect(state()).toBe(before);
    }
    run('toolbar.projection.orthographic'); expect(state().projection).toBe('orthographic');
    expect(state().assembly).toBe(before.assembly);
  });

  it('開いていた別の画面の遅い閉じ処理は、現在の画面を閉じない', () => {
    const original = state().document;
    run('toolbar.fileMenu.exportShape'); expect(state().utilityPanel).toBe('export');
    run('toolbar.fileMenu.compareDocuments'); expect(state().utilityPanel).toBe('comparison');
    state().setUtilityPanelOpen('export', false); expect(state().utilityPanel).toBe('comparison');
    run('toolbar.shape.functionPlot'); expect(state().utilityPanel).toBe('functionPlot');
    state().setUtilityPanelOpen('comparison', false); expect(state().utilityPanel).toBe('functionPlot');
    state().setUtilityPanelOpen('functionPlot', false); expect(state().utilityPanel).toBeNull();
    expect(state().document).toBe(original); expect(state().canUndo).toBe(false);
  });

  it.each(DRAWING_DIMENSION_KINDS)('$keyは図面の同じ測り方へ接続し、確定前の形と履歴を保つ', item => {
    openDrawing(); const original = state().drawing;
    expect(run(toolbarCommandId('drawing', item.key)).status).toBe('executed');
    expect(state().drawingTool).toBe('dimension');
    expect(state().drawingRequestedDimension).toEqual({ kind: item.kind, measurement: item.measurement });
    expect(state().drawing).toBe(original); expect(state().canUndo).toBe(false);
  });

  it('計算中の図面から注記や出力の画面を開始しない', () => {
    openDrawing(); useAppStore.setState({ drawingBusy: true }); const before = state();
    expect(run('toolbar.drawing.note').status).toBe('disabled');
    expect(run('toolbar.drawing.export').status).toBe('disabled'); expect(state()).toBe(before);
  });

  it('図面の出力を共通の入口から開き、部品用の閉じ処理から保護する', () => {
    openDrawing(); const original = state().drawing;
    expect(run('toolbar.drawing.export').status).toBe('executed');
    expect(state().utilityPanel).toBe('drawingExport');
    state().setUtilityPanelOpen('export', false); expect(state().utilityPanel).toBe('drawingExport');
    expect(state().drawing).toBe(original); expect(state().canUndo).toBe(false);
  });
});
