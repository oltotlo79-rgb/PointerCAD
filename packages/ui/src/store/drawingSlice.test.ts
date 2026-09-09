import { createDrawingDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { activeDocument, activeDocumentKind, activeDrawingDocument, activePartDocument } from './documentKind.js';
import { createInitialDocumentState } from './initialDocumentState.js';
import { useAppStore } from './useAppStore.js';

const source = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-09T00:00:00.000Z' } as const;

describe('drawingSlice', () => {
  beforeEach(() => { useAppStore.setState(createInitialDocumentState()); });

  it('図面を開くと文書種類がdrawingになり、裏の部品は読めない', () => {
    const drawing = createDrawingDocument('図面1', source);
    useAppStore.getState().openDrawing(drawing);
    const state = useAppStore.getState();
    expect(activeDocumentKind(state)).toBe('drawing');
    expect(activeDrawingDocument(state)).toBe(drawing);
    expect(activePartDocument(state)).toBeNull();
    expect(activeDocument(state).kind).toBe('drawing');
  });

  it('図面を閉じると元の部品へ戻る', () => {
    useAppStore.getState().openDrawing(createDrawingDocument('図面1', source));
    useAppStore.getState().closeDrawing();
    expect(activeDocumentKind(useAppStore.getState())).toBe('part');
  });

  it('図面の変更は文書の世代を進める', () => {
    const drawing = createDrawingDocument('図面1', source);
    useAppStore.getState().openDrawing(drawing);
    const before = useAppStore.getState().documentVersion;
    useAppStore.getState().applyDrawing({ ...drawing, name: '図面2' });
    expect(useAppStore.getState().documentVersion).toBe(before + 1);
  });

  it('保存済みとして開くと名前と保存状態を共通入口から読める', () => {
    const drawing = createDrawingDocument('図面1', source);
    useAppStore.getState().openDrawing(drawing, { saved: true, fileName: 'drawing.pcadd' });
    expect(activeDocument(useAppStore.getState())).toMatchObject({
      kind: 'drawing', document: drawing, saved: drawing, fileName: 'drawing.pcadd',
    });
  });
});
