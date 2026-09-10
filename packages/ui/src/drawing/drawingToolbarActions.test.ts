import { beforeEach, describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import type { DrawingView } from '@pointercad/drawing';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { runDrawingToolbarAction, updateSelectedDrawingViewLines } from './drawingToolbarActions.js';
import { DRAWING_DIMENSION_KINDS } from './drawingToolbarItems.js';

const state = () => useAppStore.getState();
const view: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], direction: [0, 0, 1], xDir: [1, 0, 0],
  scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' };
beforeEach(() => {
  resetTestStore();
  state().openDrawing({ ...createDrawingDocument('図面', { sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' }),
    views: [view, { ...view, id: 'second' }] });
  useAppStore.setState({ drawingSourceResolution: { bodyIds: ['body'], center: [0, 0, 0], dimensionInstances: [] } });
});
describe('共通メニューから図面コマンドを使う', () => {
  it.each(DRAWING_DIMENSION_KINDS)('$keyは選んだ測り方で入力待ちにし、未確定の履歴を増やさない', (item) => {
    const original = state().drawing;
    runDrawingToolbarAction(item.key);
    expect(state().drawingTool).toBe('dimension');
    expect(state().drawingRequestedDimension).toEqual({ kind: item.kind, measurement: item.measurement });
    expect(state().drawing).toBe(original); expect(state().canUndo).toBe(false);
  });
  it.each(['section', 'detail', 'auxiliary', 'partial', 'broken'] as const)('%sの作成で選んだ元図を引き継ぐ', (kind) => {
    state().selectDrawingIds(['second']); runDrawingToolbarAction(kind);
    expect(state().drawingEditor).toMatchObject({ constructionKind: kind, sourceViewId: 'second' });
    expect(state().canUndo).toBe(false);
  });
  it('複数図の隠れ線をまとめて切り替え、一回のUndoで戻す', () => {
    const original = state().drawing; state().selectDrawingIds(['front', 'second']);
    expect(updateSelectedDrawingViewLines('hidden')).toBe(true);
    expect(state().drawing?.views.every((item) => !item.showHidden)).toBe(true);
    state().undoDrawing(); expect(state().drawing).toBe(original);
  });
  it('図未選択と再計算中は線設定を変更せず理由を出す', () => {
    const original = state().drawing;
    expect(updateSelectedDrawingViewLines('hidden')).toBe(false); expect(state().drawingMessage).not.toBeNull();
    state().selectDrawingIds(['front']); useAppStore.setState({ drawingBusy: true });
    expect(updateSelectedDrawingViewLines('centers')).toBe(false); expect(state().drawing).toBe(original);
  });
  it('中心マークの再表示で非表示履歴を戻し、他の図を変えない', () => {
    const original = state().drawing; if (original === null) throw new Error('drawing');
    state().applyDrawing({ ...original, views: [{ ...view, showCenterLines: false, hiddenCenterMarkIds: ['hidden'] }, original.views[1]] });
    const before = state().drawing; state().selectDrawingIds(['front']); runDrawingToolbarAction('centerMark');
    expect(state().drawing?.views[0]).toMatchObject({ showCenterLines: true, hiddenCenterMarkIds: [] });
    expect(state().drawing?.views[1]).toBe(original.views[1]); state().undoDrawing(); expect(state().drawing).toBe(before);
  });
  it('用紙・レイヤー・表の編集は文書を変えず該当欄を開く', () => {
    const original = state().drawing;
    runDrawingToolbarAction('layer'); expect(state().drawingEditor).toEqual({ kind: 'layer' });
    runDrawingToolbarAction('table'); expect(state().drawingEditor).toEqual({ kind: 'table' });
    runDrawingToolbarAction('sheet'); expect(state().drawingSelectedIds).toEqual([original?.id]);
    expect(state().drawing).toBe(original); expect(state().canUndo).toBe(false);
  });
});
