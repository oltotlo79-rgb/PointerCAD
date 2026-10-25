import { vi } from 'vitest';
import { prepareDocumentSession, SecurePartIdentityError } from './fileSlice.js';
import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument, emptyEmbeddedPartAttachments } from '@pointercad/model';
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

  it('作成フォームは保存文書と履歴を変えず、道具や選択が変わると解除する', () => {
    const document = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(document);
    const stack = useAppStore.getState().drawingUndoStack;
    useAppStore.getState().openDrawingEditor({ kind: 'layer' });
    expect(useAppStore.getState().drawing).toBe(document);
    expect(useAppStore.getState().drawingUndoStack).toBe(stack);
    expect(useAppStore.getState().drawingEditor).toEqual({ kind: 'layer' });
    useAppStore.getState().setDrawingTool('note');
    expect(useAppStore.getState().drawingEditor).toBeNull();
    useAppStore.getState().openDrawingEditor({ kind: 'table', tableKind: 'revision' });
    useAppStore.getState().selectDrawingIds(['layer-1']);
    expect(useAppStore.getState().drawingEditor).toBeNull();
  });

  it('新規・閉じる・Undo/Redoで前の作成フォームを持ち越さない', () => {
    const document = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(document);
    useAppStore.getState().applyDrawing({ ...document, name: '変更' });
    useAppStore.getState().openDrawingEditor({ kind: 'view' });
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawingEditor).toBeNull();
    useAppStore.getState().openDrawingEditor({ kind: 'layer' });
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawingEditor).toBeNull();
    useAppStore.getState().openDrawingEditor({ kind: 'layer' });
    useAppStore.getState().openDrawing(document);
    expect(useAppStore.getState().drawingEditor).toBeNull();
    useAppStore.getState().openDrawingEditor({ kind: 'layer' });
    useAppStore.getState().closeDrawing();
    expect(useAppStore.getState().drawingEditor).toBeNull();
    useAppStore.getState().openDrawingEditor({ kind: 'view' });
    expect(useAppStore.getState().drawingEditor).toBeNull();
  });

  it('添付のない旧図面の明示mapは、同じ参照元の注記編集とUndo/Redoで保つ', () => {
    const drawing = createDrawingDocument('図面', source);
    const sources = { sources: [] };
    const shapes = new Map([['shape-1', Uint8Array.of(1)]]);
    useAppStore.getState().openDrawing(drawing, { sources, importedShapes: shapes, saved: true, fileName: 'old.pcadd' });
    expect(useAppStore.getState().drawingUndoStack?.present.importedShapes).toBe(shapes);
    useAppStore.getState().applyDrawing({ ...drawing, name: '注記' });
    expect(useAppStore.getState().drawingImportedShapes).toBe(shapes);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(shapes);
    expect(useAppStore.getState().drawingImportedShapes.get('shape-1')).toEqual(Uint8Array.of(1));
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(shapes);
    expect(useAppStore.getState().drawingSources).toBe(sources);
    expect(useAppStore.getState().savedDrawing).toBe(drawing);
    expect(useAppStore.getState().savedDrawingSources).toBe(sources);
    expect(useAppStore.getState().drawingFileName).toBe('old.pcadd');
  });

  it('同じ参照名でもhashが変わりentryがなければ旧mapを流用しない', () => {
    const drawing = createDrawingDocument('図面', source);
    const shapes = new Map([['shape-1', Uint8Array.of(1)]]);
    useAppStore.getState().openDrawing(drawing, { importedShapes: shapes });
    const changed = { ...drawing, source: { ...source, contentHash: 'new-hash' } };
    useAppStore.getState().applyDrawing(changed, { sources: [] });
    expect(useAppStore.getState().drawingImportedShapes.size).toBe(0);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(shapes);
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawingImportedShapes.size).toBe(0);
  });

  it('一致する部品entryの新しい添付mapを採用し、各履歴のbyteを戻す', () => {
    const drawing = createDrawingDocument('図面', source);
    const oldShapes = new Map([['shape-1', Uint8Array.of(1)]]);
    const newShapes = new Map([['shape-1', Uint8Array.of(2)]]);
    const changedSource = { ...source, contentHash: 'new-hash' };
    const sources = { sources: [{ metadata: changedSource, document: createEmptyPartDocument(),
      attachments: { ...emptyEmbeddedPartAttachments(), shapes: newShapes } }] };
    useAppStore.getState().openDrawing(drawing, { importedShapes: oldShapes });
    useAppStore.getState().applyDrawing({ ...drawing, source: changedSource }, sources);
    expect(useAppStore.getState().drawingImportedShapes).toBe(newShapes);
    expect(useAppStore.getState().drawingImportedShapes.get('shape-1')).toEqual(Uint8Array.of(2));
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(oldShapes);
    expect(useAppStore.getState().drawingImportedShapes.get('shape-1')).toEqual(Uint8Array.of(1));
    useAppStore.getState().redoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(newShapes);
    expect(useAppStore.getState().drawingSources).toBe(sources);
  });

  it('重複entryや参照種別違いは別sourceのmapで覆い隠さない', () => {
    const drawing = createDrawingDocument('図面', source);
    const oldShapes = new Map([['shape-1', Uint8Array.of(1)]]);
    const foreignShapes = new Map([['shape-1', Uint8Array.of(9)]]);
    const changedSource = { ...source, sourceRef: 'source-2', contentHash: 'other-hash' };
    const entry = { metadata: changedSource, document: createEmptyPartDocument(),
      attachments: { ...emptyEmbeddedPartAttachments(), shapes: foreignShapes } };
    useAppStore.getState().openDrawing(drawing, { importedShapes: oldShapes });
    const duplicate = { ...entry, metadata: source };
    useAppStore.getState().applyDrawing({ ...drawing, name: '重複' }, { sources: [duplicate, duplicate] });
    expect(useAppStore.getState().drawingImportedShapes.size).toBe(0);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(oldShapes);
    useAppStore.getState().applyDrawing({ ...drawing, source: changedSource }, { sources: [{ ...entry,
      metadata: { ...changedSource, sourceKind: 'assembly' as const } }] });
    expect(useAppStore.getState().drawingImportedShapes.size).toBe(0);
    useAppStore.getState().undoDrawing();
    useAppStore.getState().applyDrawing({ ...drawing, source: changedSource }, { sources: [{ ...entry, metadata: source }] });
    expect(useAppStore.getState().drawingImportedShapes.size).toBe(0);
  });

  it('一致する組立entryには部品の明示mapを持ち越さない', () => {
    const drawing = createDrawingDocument('図面', source);
    const shapes = new Map([['shape-1', Uint8Array.of(1)]]);
    const assemblySource = { ...source, sourceKind: 'assembly' as const, contentHash: 'assembly-hash' };
    useAppStore.getState().openDrawing(drawing, { importedShapes: shapes });
    useAppStore.getState().applyDrawing({ ...drawing, source: assemblySource }, { sources: [{
      metadata: assemblySource, document: createAssemblyDocument('組立'),
    }] });
    expect(useAppStore.getState().drawingImportedShapes.size).toBe(0);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawingImportedShapes).toBe(shapes);
  });
});

describe('atomic drawing session before actual open', () => {
  beforeEach(() => { useAppStore.setState(createInitialDocumentState()); });
  it('missing entropy cannot clear the old target or replace any drawing state', () => {
    const old = createDrawingDocument('Old drawing', source);
    const next = createDrawingDocument('Next drawing', source);
    useAppStore.getState().openDrawing(old);
    const clearSaveTarget = vi.fn();
    useAppStore.setState({ fileGateway: { ...useAppStore.getState().fileGateway,
      hasSaveTarget: () => true, clearSaveTarget } });
    const before = useAppStore.getState();
    vi.stubGlobal('crypto', {});
    try {
      expect(() => before.openDrawing(next)).toThrow(SecurePartIdentityError);
      expect(() => before.closeDrawing()).toThrow(SecurePartIdentityError);
      expect(clearSaveTarget).not.toHaveBeenCalled();
      expect(useAppStore.getState()).toBe(before);
      expect(useAppStore.getState()).toEqual(before);
      expect(useAppStore.getState().fileGateway.hasSaveTarget()).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it('prepared drawing open consumes no new entropy and preserves exact drawing identity', () => {
    const next = createDrawingDocument('Prepared drawing', source);
    const session = prepareDocumentSession();
    vi.stubGlobal('crypto', {});
    try {
      useAppStore.getState().openDrawing(next, { preparedSession: session });
      expect(useAppStore.getState().drawing).toBe(next);
      expect(useAppStore.getState().activeDocumentId).toBe(session.id);
    } finally { vi.unstubAllGlobals(); }
  });
});
