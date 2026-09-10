import { beforeEach, describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { drawingPropertySelection } from './drawingPropertySelection.js';
import { setDrawingElementLayer } from './elementLayerCommands.js';

describe('選択した図面要素のレイヤー変更', () => {
  beforeEach(() => {
    resetTestStore();
    const document = createDrawingDocument('図面', { sourceRef: 'source', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: '', importedAt: '' });
    useAppStore.getState().openDrawing({ ...document, annotations: [
      { id: 'a', kind: 'note', text: '変更対象', position: [30, 40], height: 3.5, layerId: 'layer-5' },
      { id: 'b', kind: 'note', text: 'そのまま', position: [60, 40], height: 3.5, layerId: 'layer-5' },
    ] });
    useAppStore.getState().selectDrawingIds(['a']);
  });

  it('選んだ1件だけを移し、Undo1回で元のレイヤーへ戻る', () => {
    const before = useAppStore.getState().drawing;
    const selection = drawingPropertySelection(before, ['a']);
    expect(setDrawingElementLayer(selection, 'layer-1')).toBe(true);
    expect(useAppStore.getState().drawing?.annotations.map((item) => item.layerId)).toEqual(['layer-1', 'layer-5']);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(before);
  });

  it('不明なレイヤーと複数選択を拒否する', () => {
    const before = useAppStore.getState().drawing;
    expect(setDrawingElementLayer(drawingPropertySelection(before, ['a']), 'missing')).toBe(false);
    expect(setDrawingElementLayer(drawingPropertySelection(before, ['a', 'b']), 'layer-1')).toBe(false);
    expect(useAppStore.getState().drawing).toBe(before);
  });

  it('別の要素を選び直したら前の入力を適用しない', () => {
    const before = useAppStore.getState().drawing, selection = drawingPropertySelection(before, ['a']);
    useAppStore.getState().selectDrawingIds(['b']);
    expect(setDrawingElementLayer(selection, 'layer-1')).toBe(false);
    expect(useAppStore.getState().drawing).toBe(before);
  });

  it('同じ設定で履歴を増やさず、古い文書の要素にも適用しない', () => {
    const before = useAppStore.getState().drawing, selection = drawingPropertySelection(before, ['a']);
    expect(setDrawingElementLayer(selection, 'layer-5')).toBe(true);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(setDrawingElementLayer(selection, 'layer-1')).toBe(true);
    const changed = useAppStore.getState().drawing;
    expect(setDrawingElementLayer(selection, 'layer-2')).toBe(false);
    expect(useAppStore.getState().drawing).toBe(changed);
  });
});
