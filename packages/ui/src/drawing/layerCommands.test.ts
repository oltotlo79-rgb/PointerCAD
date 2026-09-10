import { beforeEach, describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingLayer, deleteDrawingLayer, moveDrawingLayer } from './layerCommands.js';

const source = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-09T00:00:00.000Z' } as const;
const draft = { name: '補助', visible: true, printable: false, color: '#123456', lineWidth: 0.35, lineType: 'dashed' } as const;
describe('図面レイヤーの操作と履歴', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    useAppStore.getState().openDrawing(createDrawingDocument('図面', source));
  });

  it('追加を1回でUndoし、Redoで設定も戻る', () => {
    const before = useAppStore.getState().drawing;
    useAppStore.getState().openDrawingEditor({ kind: 'layer' });
    expect(commitDrawingLayer(draft)).toBe(true);
    expect(useAppStore.getState().drawing?.layers.at(-1)).toMatchObject(draft);
    expect(useAppStore.getState().drawingSelectedIds).toEqual(['layer-8']);
    expect(useAppStore.getState().drawingEditor).toBeNull();
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawing).toBe(before);
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawing?.layers.at(-1)).toMatchObject(draft);
  });

  it('不正な編集は設定・履歴・作成欄を保持して理由を表示する', () => {
    const before = useAppStore.getState().drawing;
    useAppStore.getState().openDrawingEditor({ kind: 'layer' });
    expect(commitDrawingLayer({ ...draft, lineWidth: NaN })).toBe(false);
    expect(useAppStore.getState().drawing).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(useAppStore.getState().drawingEditor).toEqual({ kind: 'layer' });
    expect(useAppStore.getState().drawingMessage).toBeTruthy();
  });

  it('設定変更・並べ替え・削除をそれぞれUndoできる', () => {
    expect(commitDrawingLayer(draft, 'layer-1')).toBe(true);
    const edited = useAppStore.getState().drawing;
    expect(moveDrawingLayer('layer-1', 6)).toBe(true);
    const reordered = useAppStore.getState().drawing!;
    expect(reordered.layers.at(-1)?.id).toBe('layer-1');
    expect(deleteDrawingLayer('layer-1', reordered)).toBe(true);
    expect(useAppStore.getState().drawing?.layers.some((layer) => layer.id === 'layer-1')).toBe(false);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(reordered);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(edited);
  });

  it('削除確認中の編集・文書切替には古い削除同意を使わない', () => {
    const before = useAppStore.getState().drawing!;
    commitDrawingLayer(draft);
    const changed = useAppStore.getState().drawing;
    expect(deleteDrawingLayer('layer-1', before)).toBe(false);
    expect(useAppStore.getState().drawing).toBe(changed);
    useAppStore.getState().openDrawing(createDrawingDocument('別の図面', source));
    expect(deleteDrawingLayer('layer-1', before)).toBe(false);
  });

  it('計算中は追加・編集・移動・削除を実行しない', () => {
    const before = useAppStore.getState().drawing!;
    useAppStore.setState({ drawingBusy: true });
    expect(commitDrawingLayer(draft)).toBe(false);
    expect(commitDrawingLayer(draft, 'layer-1')).toBe(false);
    expect(moveDrawingLayer('layer-1', 2)).toBe(false);
    expect(deleteDrawingLayer('layer-1', before)).toBe(false);
    expect(useAppStore.getState().drawing).toBe(before);
  });
});
