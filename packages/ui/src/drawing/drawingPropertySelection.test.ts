import { describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import { drawingPropertySelection } from './drawingPropertySelection.js';

function drawing(): DrawingDocument {
  const base = createDrawingDocument('設定を選ぶ', {
    sourceRef: 'source', sourceKind: 'assembly', fileName: 'source.pcada', path: '', contentHash: '', importedAt: '',
  });
  return { ...base,
    views: [{ id: 'view', kind: 'front', name: '正面', direction: [0, 1, 0], xDir: [1, 0, 0], position: [100, 100],
      scale: null, showHidden: true, showCenterLines: true, layerId: base.layers[0].id }],
    dimensions: [{ id: 'dimension', kind: 'length', measurement: 'horizontal', targets: [], placement: { commonNormalCoordinate: 10, textPosition: null },
      reference: false, origin: 'manual', layerId: base.layers[0].id }],
    annotations: [{ id: 'note', kind: 'note', text: '組立後に確認', position: [10, 20], height: 3.5, layerId: base.layers[0].id }],
    tables: [{ id: 'table', kind: 'bom', position: [30, 20], columns: [], options: {}, layerId: base.layers[0].id }],
    balloons: [{ id: 'balloon', itemNumber: 1, componentIds: ['a'], position: [50, 20], leader: [[10, 10]], layerId: base.layers[0].id }],
  };
}

describe('図面プロパティの選択対象', () => {
  it('部品表と対応部品が同時に選ばれても表の設定を出す', () => {
    const document = drawing();
    expect(drawingPropertySelection(document, ['table', 'component:a', 'component:b'])).toEqual({ kind: 'table', element: document.tables[0] });
  });
  it('異なる要素の複数選択では一つ目だけを勝手に編集しない', () => {
    expect(drawingPropertySelection(drawing(), ['note', 'table'])).toEqual({ kind: 'multiple', count: 2 });
  });
  it('Undo後の消えたIDから古い要素を表示しない', () => {
    const document = drawing();
    expect(drawingPropertySelection(document, ['note']).kind).toBe('annotation');
    expect(drawingPropertySelection({ ...document, annotations: [] }, ['note'])).toEqual({ kind: 'sheet' });
    expect(drawingPropertySelection(null, ['note'])).toEqual({ kind: 'empty' });
  });
  it('重複IDを複数要素と判定しない', () => {
    const document = drawing();
    expect(drawingPropertySelection(document, ['table', 'table'])).toEqual({ kind: 'table', element: document.tables[0] });
  });
  it.each([
    ['view', 'view'], ['dimension', 'dimension'], ['note', 'annotation'], ['balloon', 'balloon'], ['table', 'table'], ['layer-1', 'layer'],
  ])('%sを選ぶと%sの欄を使う', (id, kind) => {
    expect(drawingPropertySelection(drawing(), [id]).kind).toBe(kind);
  });
});
