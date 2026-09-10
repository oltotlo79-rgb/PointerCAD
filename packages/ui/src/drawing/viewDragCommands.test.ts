import { beforeEach, describe, expect, it } from 'vitest';
import type { Dimension, DrawingDocument, GdtShapeTarget } from '@pointercad/drawing';
import { createDrawingDocument } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginDrawingViewDrag, finishDrawingViewDrag, previewDrawingViewDrag } from './viewDragCommands.js';

beforeEach(resetTestStore);
const reference: GdtShapeTarget = { kind: 'subShape', sourceRef: 'source', viewId: 'front', ref: { bodyFeatureId: 'box', index: 0,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 20, position: [10, 0, 0], axis: [1, 0, 0], radius: null } } };
function setup(): DrawingDocument {
  const base = createDrawingDocument('移動する図', { sourceRef: 'source', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' });
  const dimension: Dimension = { id: 'dimension', kind: 'length', measurement: 'trueDistance', targets: [reference],
    placement: { commonNormalCoordinate: 80, textPosition: [110, 81] }, origin: 'manual', reference: false, layerId: 'layer-4' };
  const doc: DrawingDocument = { ...base, views: [{ id: 'front', name: '正面', kind: 'front', direction: [0, 1, 0], xDir: [1, 0, 0],
    position: [100, 100], scale: 1, layerId: 'layer-1', showHidden: true, showCenterLines: true }], dimensions: [dimension],
    annotations: [{ id: 'note', kind: 'leaderNote', text: '加工面', height: 3.5, position: [130, 90], leader: [[110, 100], [130, 90]],
      sourceTarget: reference, layerId: 'layer-5' }, { id: 'fixed-note', kind: 'note', text: '用紙の注記', height: 3.5, position: [200, 20], layerId: 'layer-5' }],
    datums: [{ id: 'datum', feature: { kind: 'line', target: reference }, label: 'A', height: 3.5, position: [110, 120], layerId: 'layer-5' }],
    gdtFrames: [{ id: 'gdt', feature: { kind: 'line', target: reference }, position: [160, 120], height: 3.5, layerId: 'layer-5',
      segments: [{ characteristic: 'straightness', zone: 'betweenLines', tolerance: { expression: { source: '0.1/2', value: 0.05, display: '0.05' }, unit: 'mm' },
        material: 'none', datums: [], basicDimensionIds: [] }] }],
    weldSymbols: [{ id: 'weld', target: reference, system: 'B', sides: [{ kind: 'squareButt', side: 'arrow', contour: 'none', finish: 'none' }],
      allAround: false, fieldWeld: false, tail: '', position: [150, 160], height: 3.5, layerId: 'layer-5' }],
  };
  useAppStore.getState().openDrawing(doc); return doc;
}
const state = () => useAppStore.getState();
const begin = () => beginDrawingViewDrag('front', [100, 100], new Map([['dimension', [0, 1] as const]]));

describe('図と参照付き記入の一括ドラッグ', () => {
  it('実寸と式は保持し、投影・寸法・データム・公差・溶接・引出線を同じ量で動かす', () => {
    const document = setup(), drag = begin(); if (drag === null) throw new Error('view drag');
    const next = previewDrawingViewDrag(drag, [110, 120]); if (next === null) throw new Error('preview');
    expect(next.views[0].position).toEqual([110, 120]);
    expect(next.dimensions[0].placement).toEqual({ commonNormalCoordinate: 100, textPosition: [120, 101] });
    expect(next.dimensions[0].targets[0]).toBe(reference);
    expect(next.annotations[0]).toMatchObject({ position: [140, 110], leader: [[120, 120], [140, 110]] });
    expect(next.annotations[1]).toBe(document.annotations[1]);
    expect(next.datums[0].position).toEqual([120, 140]); expect(next.gdtFrames[0].position).toEqual([170, 140]);
    expect(next.gdtFrames[0].segments).toBe(document.gdtFrames[0].segments);
    expect(next.weldSymbols[0].position).toEqual([160, 180]); expect(next.weldSymbols[0].sides).toBe(document.weldSymbols[0].sides);
    expect(next.source).toBe(document.source); expect(state().drawing).toBe(document);
  });
  it('100回のプレビューは履歴を変えず、確定のUndo/Redoは各1回', () => {
    const document = setup(), version = state().documentVersion, drag = begin(); if (drag === null) throw new Error('view drag');
    for (let i = 0; i < 100; i++) previewDrawingViewDrag(drag, [100 + i / 10, 100 + i / 10]);
    expect(state().drawing).toBe(document); expect(state().documentVersion).toBe(version);
    expect(finishDrawingViewDrag(drag, [110, 120])).toBe(true); const moved = state().drawing;
    expect(state().documentVersion).toBe(version + 1); expect(state().drawingSelectedIds).toEqual(['front']);
    state().undo(); expect(state().drawing).toBe(document); state().redo(); expect(state().drawing).toBe(moved);
  });
  it('自動文字位置は自動のまま、紙面の点参照と風船の引出線も追従する', () => {
    const document = setup();
    const point = { kind: 'point' as const, viewId: 'front', paperPoint: [100, 100] as const, modelPoint: [0, 0, 0] as const };
    state().applyDrawing({ ...document, dimensions: [{ ...document.dimensions[0], targets: [point],
      placement: { commonNormalCoordinate: 80, textPosition: null } }],
      balloons: [{ id: 'balloon', sourceTarget: point, position: [120, 120], leader: [[100, 100], [120, 120]],
        itemNumber: 1, componentIds: ['part-1'], layerId: 'layer-5' }] });
    const drag = begin(); if (drag === null) throw new Error('view drag');
    const next = previewDrawingViewDrag(drag, [110, 120]);
    expect(next?.dimensions[0].placement).toEqual({ commonNormalCoordinate: 100, textPosition: null });
    expect(next?.dimensions[0].targets[0]).toEqual({ ...point, paperPoint: [110, 120] });
    expect(next?.balloons[0]).toMatchObject({ position: [130, 140], leader: [[110, 120], [130, 140]], sourceTarget: { ...point, paperPoint: [110, 120] } });
  });
  it('紙外・非有限・ゼロ移動・計算中・古い文書の操作は確定しない', () => {
    const document = setup(), drag = begin(); if (drag === null) throw new Error('view drag');
    for (const point of [[-1000, 0], [NaN, 100], [100, 100]] as const) expect(finishDrawingViewDrag(drag, point)).toBe(false);
    expect(state().drawing).toBe(document);
    useAppStore.setState({ drawingBusy: true }); expect(finishDrawingViewDrag(drag, [110, 120])).toBe(false);
    useAppStore.setState({ drawingBusy: false }); state().applyDrawing({ ...document, name: '更新済み' });
    const changed = state().drawing; expect(finishDrawingViewDrag(drag, [110, 120])).toBe(false); expect(state().drawing).toBe(changed);
  });
  it('不明な図や解決していない寸法方向を推測しない', () => {
    setup(); expect(beginDrawingViewDrag('missing', [0, 0], new Map())).toBeNull();
    expect(beginDrawingViewDrag('front', [0, 0], new Map())).toBeNull();
  });
});
