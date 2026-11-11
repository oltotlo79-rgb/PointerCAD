import { createDrawingDocument, createEmptyPartDocument, embedDrawingSource, emptyDrawingSourceLibrary } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { createParameterTutorialSession } from '../tutorial/tutorialProgress.js';
import { closeDrawingWithConfirmation } from './closeDrawing.js';

const source = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-09T00:00:00.000Z' } as const;
beforeEach(() => { useAppStore.setState({ ...createInitialDocumentState(), tutorialSession: null,
  tutorialDrawingProof: null, tutorialExports: {} }); });

async function openSavedColdGuide() {
  const initial = useAppStore.getState();
  const part = createEmptyPartDocument();
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
    { sourceKind: 'part', document: part }, 'guide.pcad', '');
  const drawing = createDrawingDocument('保存した図面', embedded.source);
  initial.openDrawing(drawing, { saved: true, sources: embedded.library });
  const opened = useAppStore.getState();
  const session = createParameterTutorialSession(part, opened.documentVersion);
  if (session === null) throw new Error('session missing');
  opened.setTutorialSession(session);
  opened.setTutorialDrawingProof({ document: drawing, sourcePart: part,
    sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });
  return { part, drawing, embedded };
}

function expectColdGuideUnchanged(before: ReturnType<typeof useAppStore.getState>): void {
  const after = useAppStore.getState();
  expect(after.document).toBe(before.document);
  expect(after.drawing).toBe(before.drawing);
  expect(after.undoStack).toBe(before.undoStack);
  expect(after.drawingUndoStack).toBe(before.drawingUndoStack);
  expect(after.importedShapes).toBe(before.importedShapes);
  expect(after.importedMeshes).toBe(before.importedMeshes);
  expect(after.canvases).toBe(before.canvases);
  expect(after.fileGateway).toBe(before.fileGateway);
  expect(after.savedDocument).toBe(before.savedDocument);
  expect(after.savedDrawing).toBe(before.savedDrawing);
  expect(after.tutorialSession).toBe(before.tutorialSession);
  expect(after.tutorialDrawingProof).toBe(before.tutorialDrawingProof);
}

describe('図面から部品へ戻る時の未保存保護（レビュー R03）', () => {
  it('破棄を断れば図面も Undo 履歴も残り、編集を戻せる', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '編集した図面' });
    const before = useAppStore.getState();
    const confirmDiscard = vi.fn(() => Promise.resolve(false));
    expect(await closeDrawingWithConfirmation({ confirmDiscard })).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledWith('file.discardConfirm');
    expect(useAppStore.getState().drawing).toBe(before.drawing);
    expect(useAppStore.getState().drawingUndoStack).toBe(before.drawingUndoStack);
    useAppStore.getState().undoDrawing();
    expect(useAppStore.getState().drawing).toBe(original);
  });

  it('破棄へ同意した時だけ部品へ戻る', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '変更' });
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(true) })).toBe(true);
    expect(useAppStore.getState().drawing).toBeNull();
  });

  it('保存済みの未変更図面では確認を増やさない', async () => {
    useAppStore.getState().openDrawing(createDrawingDocument('図面', source), { saved: true });
    const confirmDiscard = vi.fn(() => Promise.resolve(false));
    expect(await closeDrawingWithConfirmation({ confirmDiscard })).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it('同じ元部品へ戻った5段案内は既存のdocumentVersionへ追従し、図面確認を偽造しない', async () => {
    const before = useAppStore.getState();
    const drawing = createDrawingDocument('図面', source);
    before.openDrawing(drawing, { saved: true });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(opened.document, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    const undo = opened.undoStack;
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(false) })).toBe(true);
    const returned = useAppStore.getState();
    expect(returned.tutorialSession?.documentVersion).toBe(returned.documentVersion);
    expect(returned.tutorialDrawingProof).toBeNull();
    expect(returned.document).toBe(before.document);
    expect(returned.undoStack).toBe(undo);
  });

  it('同じ元部品の保存済みガイド図面は明示復帰でも通常closeのUndoを保つ', async () => {
    const initial = useAppStore.getState();
    const drawing = createDrawingDocument('図面', source);
    initial.openDrawing(drawing, { saved: true });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(opened.document, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    opened.setTutorialDrawingProof({ document: drawing, sourcePart: opened.document,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });
    const before = useAppStore.getState();
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(false) },
      { resumeGuidePart: true })).toBe(true);
    const returned = useAppStore.getState();
    expect(returned.drawing).toBeNull();
    expect(returned.document).toBe(before.document);
    expect(returned.undoStack).toBe(before.undoStack);
    expect(returned.tutorialSession?.documentVersion).toBe(returned.documentVersion);
  });

  it('確認待機中の追加編集を古い破棄の回答で消さない', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '最初の編集' });
    let answer: (value: boolean) => void = () => { throw new Error('未初期化'); };
    const response = new Promise<boolean>((resolve) => { answer = resolve; });
    const pending = closeDrawingWithConfirmation({ confirmDiscard: () => response });
    const latest = { ...original, name: '確認待機中の編集' };
    useAppStore.getState().applyDrawing(latest);
    answer(true); expect(await pending).toBe(false);
    expect(useAppStore.getState().drawing).toBe(latest);
  });

  it('確認待機中に元部品が変わったら図面を閉じず新しい部品を保つ', async () => {
    const original = createDrawingDocument('図面', source);
    useAppStore.getState().openDrawing(original);
    useAppStore.getState().applyDrawing({ ...original, name: '未保存の図面' });
    let answer: (value: boolean) => void = () => { throw new Error('未初期化'); };
    const response = new Promise<boolean>(resolve => { answer = resolve; });
    const pending = closeDrawingWithConfirmation({ confirmDiscard: () => response });
    const before = useAppStore.getState();
    const editedPart = { ...before.document, name: '待機中に変更した部品' };
    before.applyDocument(editedPart);
    answer(true);
    expect(await pending).toBe(false);
    const after = useAppStore.getState();
    expect(after.document).toBe(editedPart);
    expect(after.drawing).toBe(before.drawing);
  });

  it('図面だけの冷再開は実図面の埋込部品を明示的に開き、別の保存先を流用しない', async () => {
    // Keep the same-ID collision explicit; new sessions normally use unique IDs.
    useAppStore.setState({ document: { ...useAppStore.getState().document, id: 'part-1' } });
    const previous = useAppStore.getState();
    const part = createEmptyPartDocument();
    expect(previous.document.id).toBe(part.id);
    expect(previous.document).not.toBe(part);
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part }, 'guide.pcad', '');
    const drawing = createDrawingDocument('保存した図面', embedded.source);
    previous.openDrawing(drawing, { saved: true, sources: embedded.library });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(part, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    opened.setTutorialDrawingProof({ document: drawing, sourcePart: part,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });
    const oldUndo = opened.undoStack;
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(false) },
      { resumeGuidePart: true })).toBe(true);
    const returned = useAppStore.getState();
    expect(returned.drawing).toBeNull();
    expect(returned.document).toBe(part);
    expect(returned.savedDocument).toBe(part);
    expect(returned.fileName).toBeNull();
    expect(returned.undoStack).not.toBe(oldUndo);
    expect(returned.tutorialSession?.documentVersion).toBe(returned.documentVersion);
    expect(returned.tutorialDrawingProof?.sourcePart).toBe(part);
    expect(returned.fileGateway.hasSaveTarget()).toBe(false);
  });

  it('冷再開で埋込sourceが消えたら図面だけを閉じず、状態を保つ', async () => {
    const { drawing } = await openSavedColdGuide();
    useAppStore.getState().applyDrawing(drawing, { sources: [] });
    const before = useAppStore.getState();
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(true) },
      { resumeGuidePart: true })).toBe(false);
    expectColdGuideUnchanged(before);
  });

  it('冷再開で同じ参照の埋込sourceが重複したら先頭だけ採用しない', async () => {
    const { drawing, embedded } = await openSavedColdGuide();
    const sourceEntry = embedded.library.sources[0];
    if (sourceEntry === undefined) throw new Error('source missing');
    useAppStore.getState().applyDrawing(drawing, { sources: [sourceEntry, sourceEntry] });
    const before = useAppStore.getState();
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(true) },
      { resumeGuidePart: true })).toBe(false);
    expectColdGuideUnchanged(before);
  });

  it('冷再開で同じID・内容でも別埋込部品をproofのownerとして採用しない', async () => {
    const { drawing, embedded } = await openSavedColdGuide();
    const sourceEntry = embedded.library.sources[0];
    if (sourceEntry === undefined || sourceEntry.metadata.sourceKind !== 'part') throw new Error('part source missing');
    useAppStore.getState().applyDrawing(drawing, { sources: [{ ...sourceEntry,
      document: { ...sourceEntry.document } }] });
    const before = useAppStore.getState();
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(true) },
      { resumeGuidePart: true })).toBe(false);
    expectColdGuideUnchanged(before);
  });

  it('冷再開の未保存確認中にsourceが変わったら古い同意で閉じない', async () => {
    const { drawing, embedded } = await openSavedColdGuide();
    useAppStore.getState().applyDrawing(drawing, { sources: [...embedded.library.sources] });
    let answer: (value: boolean) => void = () => { throw new Error('answer missing'); };
    const response = new Promise<boolean>(resolve => { answer = resolve; });
    const pending = closeDrawingWithConfirmation({ confirmDiscard: () => response },
      { resumeGuidePart: true });
    useAppStore.getState().applyDrawing(drawing, { sources: [] });
    const before = useAppStore.getState();
    answer(true);
    expect(await pending).toBe(false);
    expectColdGuideUnchanged(before);
  });

  it('埋込部品のhashが図面と食い違えば文書・Undo・添付を一切変えない', async () => {
    const previous = useAppStore.getState();
    const part = createEmptyPartDocument();
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part }, 'guide.pcad', '');
    const drawing = createDrawingDocument('保存した図面', embedded.source);
    const tampered = { ...part, name: '変更された埋込部品' };
    const sourceEntry = embedded.library.sources[0];
    if (sourceEntry === undefined) throw new Error('source missing');
    previous.openDrawing(drawing, { saved: true, sources: { sources: [{ ...sourceEntry, document: tampered }] } });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(tampered, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    opened.setTutorialDrawingProof({ document: drawing, sourcePart: tampered,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });
    const before = useAppStore.getState();
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(false) },
      { resumeGuidePart: true })).toBe(false);
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.drawing).toBe(before.drawing);
    expect(after.importedShapes).toBe(before.importedShapes);
    expect(after.canvases).toBe(before.canvases);
  });

  it('添付の事前処理が例外を投げても図面・部品・Undo・保存先を部分変更しない', async () => {
    const initial = useAppStore.getState();
    const part = createEmptyPartDocument();
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part }, 'guide.pcad', '');
    const drawing = createDrawingDocument('保存した図面', embedded.source);
    initial.openDrawing(drawing, { saved: true, sources: embedded.library });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(part, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    opened.setTutorialDrawingProof({ document: drawing, sourcePart: part,
      sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash });
    // The embedded source is valid; a retained asset map fails only during attachment preflight.
    class UnreadableShapes extends Map<string, Uint8Array> {
      override [Symbol.iterator](): never { throw new Error('retained attachment unavailable'); }
    }
    const shapes = new UnreadableShapes();
    shapes.set('retained', Uint8Array.of(1));
    useAppStore.setState({ importedShapes: shapes });
    const before = useAppStore.getState();
    expect(await closeDrawingWithConfirmation({ confirmDiscard: () => Promise.resolve(false) },
      { resumeGuidePart: true })).toBe(false);
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document);
    expect(after.drawing).toBe(before.drawing);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.drawingUndoStack).toBe(before.drawingUndoStack);
    expect(after.importedShapes).toBe(before.importedShapes);
    expect(after.importedMeshes).toBe(before.importedMeshes);
    expect(after.canvases).toBe(before.canvases);
    expect(after.fileGateway).toBe(before.fileGateway);
    expect(after.tutorialSession).toBe(before.tutorialSession);
  });
});
