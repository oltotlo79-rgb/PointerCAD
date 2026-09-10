import { describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import type { DrawingDocument } from '@pointercad/drawing';
import { selectedDrawingElementIds } from './selectedDrawingElementIds.js';

function drawing(): DrawingDocument {
  const document = createDrawingDocument('選択の図面', {
    sourceRef: 'source', sourceKind: 'part', fileName: 'source.pcad', path: '', contentHash: '', importedAt: '',
  });
  const sourceLayer = document.layers[0];
  return {
    ...document,
    layers: [{ ...sourceLayer, id: 'notes', name: '注記' }, { ...sourceLayer, id: 'tables', name: '表' }],
    annotations: [{ id: 'note-a', kind: 'note', text: '取付面', position: [20, 30], height: 3.5, layerId: 'notes' }],
    balloons: [{ id: 'balloon-a', itemNumber: 1, componentIds: ['occurrence-a'], position: [40, 30], leader: [], layerId: 'notes' }],
    tables: [{ id: 'table-a', kind: 'revision', position: [60, 30], columns: [], rows: [], options: {}, layerId: 'tables' }],
  };
}

describe('レイヤー選択と図面の対応表示', () => {
  it('レイヤーの注記と風船を表示対象へ加えても、削除操作の選択を広げない', () => {
    const selected = Object.freeze(['notes']);
    const result = selectedDrawingElementIds(drawing(), selected);
    expect(result).toEqual(new Set(['notes', 'note-a', 'balloon-a']));
    expect(selected).toEqual(['notes']);
    expect(result.has('table-a')).toBe(false);
  });

  it('既に選んだ別レイヤーの表と配置IDはそのまま残す', () => {
    const result = selectedDrawingElementIds(drawing(), ['notes', 'table-a', 'component:occurrence-b']);
    expect(result).toEqual(new Set(['notes', 'table-a', 'component:occurrence-b', 'note-a', 'balloon-a']));
  });

  it('空の選択や削除済みのレイヤーで全要素を強調しない', () => {
    expect(selectedDrawingElementIds(drawing(), [])).toEqual(new Set());
    expect(selectedDrawingElementIds(drawing(), ['removed-layer'])).toEqual(new Set(['removed-layer']));
  });
});
