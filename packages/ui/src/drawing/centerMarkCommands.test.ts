import { beforeEach, describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import { createCenterMarks, type DrawingView } from '@pointercad/drawing';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { setDrawingCenterMarkVisible } from './centerMarkCommands.js';

const state = () => useAppStore.getState();
const view: DrawingView = { id: 'front', kind: 'front', name: '正面', direction: [0, 0, 1], xDir: [1, 0, 0],
  position: [100, 100], scale: 1, showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const marks = createCenterMarks(view, [
  { id: 'circle-a', kind: 'circle', center: [100, 100], radius: 10 },
  { id: 'circle-b', kind: 'circle', center: [100, 100], radius: 5 },
  { id: 'circle-c', kind: 'circle', center: [150, 100], radius: 5 },
]);
function resolve() {
  const document = state().drawing; if (document === null || marks === null) throw new Error('中心マークの文書が必要');
  useAppStore.setState({ drawingResolution: { ok: true, document, dimensions: [], unresolvedCount: 0, sourceChangedExternally: false,
    projection: { ok: true, failures: [], cancelled: false, views: [{ viewId: view.id, name: view.name, position: view.position,
      scale: 1, visible: [], hidden: [], cuttingCurves: [], centerMarks: marks }] } } });
  return document;
}
beforeEach(() => {
  resetTestStore(); state().openDrawing({ ...createDrawingDocument('図面', { sourceRef: 'part', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' }), views: [view] });
  resolve();
});
describe('中心マークの個別表示を履歴へつなぐ', () => {
  it('同心の2円だけを隠し、他の円は残す。1回のUndoで元文書に戻る', () => {
    const document = resolve(); if (marks === null) throw new Error('中心マーク');
    expect(setDrawingCenterMarkVisible(document, view.id, marks[0].id, false)).toBe(true);
    expect(state().drawing?.views[0].hiddenCenterMarkIds).toEqual(marks[0].sourceIds);
    expect(state().drawing?.views[0].hiddenCenterMarkIds).not.toContain(marks[1].sourceIds[0]);
    state().undoDrawing(); expect(state().drawing).toBe(document); expect(state().canUndo).toBe(false);
  });
  it('個別に再表示でき、同じ指定を繰り返しても履歴を増やさない', () => {
    if (marks === null) throw new Error('中心マーク');
    setDrawingCenterMarkVisible(resolve(), view.id, marks[0].id, false);
    expect(setDrawingCenterMarkVisible(resolve(), view.id, marks[0].id, true)).toBe(true);
    const document = resolve(); expect(document.views[0].hiddenCenterMarkIds).toEqual([]);
    expect(setDrawingCenterMarkVisible(document, view.id, marks[0].id, true)).toBe(false); expect(state().drawing).toBe(document);
  });
  it('古い文書・未更新の投影・処理中・未知の組から変更しない', () => {
    if (marks === null) throw new Error('中心マーク');
    const document = resolve();
    expect(setDrawingCenterMarkVisible(document, view.id, 'unknown', false)).toBe(false);
    useAppStore.setState({ drawingBusy: true }); expect(setDrawingCenterMarkVisible(document, view.id, marks[0].id, false)).toBe(false);
    useAppStore.setState({ drawingBusy: false }); state().applyDrawing({ ...document, name: '変更' });
    expect(setDrawingCenterMarkVisible(document, view.id, marks[0].id, false)).toBe(false);
    const changed = state().drawing; if (changed === null) throw new Error('図面');
    expect(setDrawingCenterMarkVisible(changed, view.id, marks[0].id, false)).toBe(false);
    expect(state().drawing).toBe(changed);
  });
});
