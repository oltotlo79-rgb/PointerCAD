import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeSaveDocument, createAutoSaver, createMemoryAutoSaveStorage, readDrawingBundle, writeDrawingBundle } from '@pointercad/io';
import { createDrawingDocument, createEmptyPartDocument, embedDrawingSource, emptyDrawingSourceLibrary } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyPickedDrawing } from './drawingFile.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { openPart, savePart, type PartFileDeps } from './partFile.js';
import type { FileGateway, PickedFile } from './fileGateway.js';
import { newSketchCanvas } from './canvasFile.js';
import { currentPcadAttachments } from '../store/attachKernel.js';
import { startAutoSave } from './attachAutoSave.js';
import { readTutorialCheckpoint, TUTORIAL_CHECKPOINT_KEY } from '../tutorial/tutorialCheckpoint.js';
import { createParameterTutorialSession } from '../tutorial/tutorialProgress.js';

beforeEach(() => { resetTestStore(); useAppStore.setState({ saveDocumentEncoder: encodeSaveDocument, documentSaveOperation: null }); });
const deps: PartFileDeps = { captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true), recentFilesStorage: null };
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Not initialized'); };
  const promise = new Promise<T>((callback) => { resolve = callback; });
  return { promise, resolve };
}
function gateway() {
  let saved: PickedFile | null = null;
  let target = false;
  const savePcad = vi.fn<FileGateway['savePcad']>((name, bytes) => {
    saved = { name, bytes, saveTargetToken: 'drawing-target' }; target = true; return Promise.resolve(name);
  });
  const openPcad = vi.fn<FileGateway['openPcad']>(() => Promise.resolve(saved));
  const confirmSaveTarget = vi.fn(() => {
    expect(useAppStore.getState().drawing).not.toBeNull(); target = true;
    return Promise.resolve();
  });
  const clearSaveTarget = vi.fn(() => { target = false; });
  const value: FileGateway = { savePcad, openPcad, confirmSaveTarget, clearSaveTarget, hasSaveTarget: () => target };
  useAppStore.setState({ fileGateway: value });
  return { saved: () => saved, savePcad, openPcad, confirmSaveTarget, clearSaveTarget };
}
async function fixture() {
  const source = { sourceKind: 'part' as const, document: createEmptyPartDocument() };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'part.pcad', '');
  const document = createDrawingDocument('試験図面', embedded.source);
  useAppStore.getState().openDrawing(document, { sources: embedded.library });
  return { document, source, library: embedded.library };
}

describe('図面の実保存入口と文書の寿命(P8-64、R02)', () => {
  it('削除後の部品を参照元へ同梱しても消した画像を含めず、Undo後は元画像を同梱する', async () => {
    for (const restore of [false, true]) {
      resetTestStore();
      const g = gateway();
      const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 2, height: 1 }, 'canvas-1');
      const bytes = Uint8Array.of(1, 2, 3);
      useAppStore.getState().addCanvas(canvas, bytes);
      useAppStore.getState().removeCanvas(canvas.id);
      if (restore) useAppStore.getState().undo();
      const source = { sourceKind: 'part' as const, document: useAppStore.getState().document,
        attachments: currentPcadAttachments() };
      const other = await embedDrawingSource(emptyDrawingSourceLibrary(), {
        sourceKind: 'part', document: { ...createEmptyPartDocument(), name: 'Other', canvases: [canvas] },
        attachments: { ...source.attachments, canvases: new Map([[canvas.imageId, Uint8Array.of(8, 9)]]) },
      }, 'other.pcad', '');
      const embedded = await embedDrawingSource(other.library, source, 'part.pcad', '');
      expect(embedded.library.sources).toHaveLength(2);
      const drawing = createDrawingDocument('下絵の図面', embedded.source);
      useAppStore.getState().openDrawing(drawing, { sources: embedded.library });
      useAppStore.getState().applyDrawing({ ...drawing, name: '編集中の下絵の図面' });
      const storage = createMemoryAutoSaveStorage();
      let timer: (() => void) | undefined;
      const stop = startAutoSave({ storage, createSaver: (options) => createAutoSaver({ ...options,
        setTimeout: (callback) => { timer = callback; return 1; }, clearTimeout: () => { timer = undefined; } }) });
      try {
        timer?.();
        await vi.waitFor(async () => { expect(await storage.listRecords()).toHaveLength(1); });
        const recovery = await readDrawingBundle((await storage.listRecords())[0].bytes);
        expect(recovery.ok).toBe(true);
        if (!recovery.ok || recovery.source.sourceKind !== 'part') throw new Error('Missing drawing recovery');
        expect(recovery.source.attachments?.canvases.size).toBe(restore ? 1 : 0);
        if (restore) expect(recovery.source.attachments?.canvases.get(canvas.imageId)).toEqual(bytes);
      } finally { stop(); }
      await savePart(deps, false);
      const saved = g.saved(); if (saved === null) throw new Error('Missing drawing');
      const read = await readDrawingBundle(saved.bytes);
      expect(read.ok).toBe(true);
      if (!read.ok || read.source.sourceKind !== 'part') throw new Error('Missing source part');
      expect(read.source.attachments?.canvases.size).toBe(restore ? 1 : 0);
      if (restore) expect(read.source.attachments?.canvases.get(canvas.imageId)).toEqual(bytes);
      else expect(Buffer.from(saved.bytes).includes(Buffer.from('canvases/canvas-1.png'))).toBe(false);
    }
  });

  it('共通の保存からpcaddを作り、共通の開くで図面と参照元が戻る', async () => {
    const g = gateway(); const f = await fixture();
    await savePart(deps, false);
    expect(g.savePcad.mock.calls[0]?.[0]).toBe('試験図面.pcadd');
    expect(g.savePcad.mock.calls[0]?.[3]).toBe('drawing');
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(false);
    useAppStore.getState().closeDrawing();
    await openPart(deps);
    expect(useAppStore.getState().drawing).toEqual(f.document);
    expect(useAppStore.getState().drawingSources.sources[0]?.document).toEqual(f.source.document);
    expect(g.confirmSaveTarget).toHaveBeenCalledWith('drawing-target');
  });
  it('5段案内は保存したpcaddの実bytesと埋込部品を検証してから冷再開する', async () => {
    const g = gateway();
    // 案内の図面は、いま開いている部品から作る。保存の入口は、参照元が開いている部品そのものか、
    // 冷再開で証明済みの時だけ案内へ採用する(別の実体の部品を参照元にすると採用されない)。
    // 実際の埋込と同じく、開いている部品の添付(空でも)を付ける。無いと保存後に読み戻した参照元と原本の印が一致しない。
    const liveSource = { sourceKind: 'part' as const, document: useAppStore.getState().document,
      attachments: currentPcadAttachments() };
    const liveEmbedded = await embedDrawingSource(emptyDrawingSourceLibrary(), liveSource, 'part.pcad', '');
    useAppStore.getState().openDrawing(createDrawingDocument('試験図面', liveEmbedded.source), { sources: liveEmbedded.library });
    const fixtureValue = { source: liveSource };
    const records = new Map<string, string>();
    const storage = { getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { records.set(key, value); },
      removeItem: (key: string) => { records.delete(key); } };
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(fixtureValue.source.document, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    opened.setTutorialCheckpointStorage(storage);
    await savePart(deps, false);
    const picked = g.saved();
    if (picked === null) throw new Error('drawing save missing');
    const bundle = await readDrawingBundle(picked.bytes);
    if (!bundle.ok || bundle.source.sourceKind !== 'part') throw new Error('saved source missing');
    expect(records.has(TUTORIAL_CHECKPOINT_KEY)).toBe(true);
    expect(await readTutorialCheckpoint({ part: { document: bundle.source.document }, drawing: {
      document: bundle.document, source: bundle.source, savedBytes: picked.bytes,
    } }, storage)).toMatchObject({ ok: true });
    useAppStore.getState().closeDrawing();
    await applyPickedDrawing(picked, deps);
    const returned = useAppStore.getState();
    expect(returned.tutorialSession?.course).toBe('parameterToExport');
    expect(returned.tutorialSession?.paused).toBe(true);
    expect(returned.tutorialSession?.documentId).toBe(bundle.source.document.id);
    expect(returned.tutorialSession?.checkpointIdentity).toBeDefined();
    expect(returned.tutorialDrawingProof?.sourceRef).toBe(bundle.document.source.sourceRef);
    expect(returned.tutorialDrawingProof?.sourceHash).toBe(bundle.document.source.contentHash);
    await savePart(deps, false);
    const continued = g.saved();
    if (continued === null) throw new Error('continued drawing missing');
    const reopenedBundle = await readDrawingBundle(continued.bytes);
    if (!reopenedBundle.ok || reopenedBundle.source.sourceKind !== 'part') throw new Error('continued source missing');
    expect(await readTutorialCheckpoint({ part: { document: reopenedBundle.source.document }, drawing: {
      document: reopenedBundle.document, source: reopenedBundle.source, savedBytes: continued.bytes,
    } }, storage)).toMatchObject({ ok: true });
  });
  it('同じpart-1 IDでも無関係の図面sourceを案内へ採用しない', async () => {
    // Keep the same-ID collision explicit; new sessions normally use unique IDs.
    useAppStore.setState({ document: { ...useAppStore.getState().document, id: 'part-1' } });
    const initial = useAppStore.getState();
    const otherPart = createEmptyPartDocument();
    expect(initial.document.id).toBe(otherPart.id);
    expect(initial.document).not.toBe(otherPart);
    const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: otherPart }, 'other.pcad', '');
    initial.openDrawing(createDrawingDocument('別部品の図面', embedded.source), { sources: embedded.library });
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(opened.document, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    opened.setTutorialSession(session);
    const records = new Map([[TUTORIAL_CHECKPOINT_KEY, 'foreign source record']]);
    opened.setTutorialCheckpointStorage({ getItem: key => records.get(key) ?? null,
      setItem: (key, value) => { records.set(key, value); } });
    const g = gateway();
    const undo = useAppStore.getState().drawingUndoStack;
    await savePart(deps, false);
    expect(g.saved()).not.toBeNull();
    expect(records.get(TUTORIAL_CHECKPOINT_KEY)).toBe('foreign source record');
    expect(useAppStore.getState().tutorialDrawingProof).toBeNull();
    expect(useAppStore.getState().drawingUndoStack).toBe(undo);
  });
  it('保存中の追加編集を保存済みにしない', async () => {
    const g = gateway(); const f = await fixture(); const write = deferred<string | null>();
    g.savePcad.mockReturnValueOnce(write.promise);
    const saving = savePart(deps, false);
    await vi.waitFor(() => expect(g.savePcad).toHaveBeenCalledOnce());
    useAppStore.getState().applyDrawing({ ...f.document, name: '編集中' });
    write.resolve('before.pcadd'); await saving;
    expect(useAppStore.getState().savedDrawing).toBe(f.document);
    expect(useAppStore.getState().drawing?.name).toBe('編集中');
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
  });
  it('参照元だけの変更も保存中に追加されれば未保存として残す', async () => {
    const g = gateway(); const f = await fixture(); const write = deferred<string | null>();
    g.savePcad.mockReturnValueOnce(write.promise);
    const saving = savePart(deps, false);
    await vi.waitFor(() => expect(g.savePcad).toHaveBeenCalledOnce());
    const updated = { sources: f.library.sources.map((entry) => ({ ...entry, document: { ...entry.document, name: '変更した部品' } })) };
    useAppStore.getState().applyDrawing(f.document, updated);
    write.resolve('saved.pcadd'); await saving;
    expect(useAppStore.getState().savedDrawingSources).toBe(f.library);
    expect(activeHasUnsavedChanges(useAppStore.getState())).toBe(true);
  });
  it('文書切替後に完了した保存が別の図面の保存状態を変えない', async () => {
    const g = gateway(); const first = await fixture(); const write = deferred<string | null>();
    const before = useAppStore.getState();
    const session = createParameterTutorialSession(first.source.document, before.documentVersion);
    if (session === null) throw new Error('session missing');
    const records = new Map([[TUTORIAL_CHECKPOINT_KEY, 'previous checkpoint']]);
    before.setTutorialSession(session);
    before.setTutorialCheckpointStorage({ getItem: key => records.get(key) ?? null,
      setItem: (key, value) => { records.set(key, value); } });
    g.savePcad.mockReturnValueOnce(write.promise);
    const saving = savePart(deps, false);
    await vi.waitFor(() => expect(g.savePcad).toHaveBeenCalledOnce());
    const next = await fixture();
    write.resolve('old.pcadd'); await saving;
    expect(useAppStore.getState().drawing).toBe(next.document);
    expect(useAppStore.getState().drawingFileName).toBeNull();
    expect(useAppStore.getState().savedDrawing).toBeNull();
    expect(records.get(TUTORIAL_CHECKPOINT_KEY)).toBe('previous checkpoint');
  });
  it('連続保存は最初の書込完了後に次を開始する', async () => {
    const g = gateway(); const f = await fixture(); const write = deferred<string | null>();
    g.savePcad.mockReturnValueOnce(write.promise);
    const first = savePart(deps, false);
    await vi.waitFor(() => expect(g.savePcad).toHaveBeenCalledOnce());
    useAppStore.getState().applyDrawing({ ...f.document, name: '二回目' });
    const second = savePart(deps, false);
    await Promise.resolve(); expect(g.savePcad).toHaveBeenCalledOnce();
    write.resolve('first.pcadd'); await Promise.all([first, second]);
    expect(g.savePcad).toHaveBeenCalledTimes(2);
    const final = g.savePcad.mock.calls[1];
    if (final === undefined) throw new Error('Missing save');
    expect(await readDrawingBundle(final[1])).toMatchObject({ ok: true, document: { name: '二回目' } });
  });
  it('保存の取消では保存済みの印を付けない', async () => {
    const g = gateway(); const current = await fixture(); g.savePcad.mockResolvedValueOnce(null);
    const opened = useAppStore.getState();
    const session = createParameterTutorialSession(current.source.document, opened.documentVersion);
    if (session === null) throw new Error('session missing');
    const records = new Map([[TUTORIAL_CHECKPOINT_KEY, 'previous checkpoint']]);
    opened.setTutorialSession(session);
    opened.setTutorialCheckpointStorage({ getItem: key => records.get(key) ?? null,
      setItem: (key, value) => { records.set(key, value); } });
    await savePart(deps, false);
    expect(useAppStore.getState().savedDrawing).toBeNull();
    expect(useAppStore.getState().drawingFileName).toBeNull();
    expect(useAppStore.getState().tutorialDrawingProof).toBeNull();
    expect(records.get(TUTORIAL_CHECKPOINT_KEY)).toBe('previous checkpoint');
  });
  it('保存失敗では文書と参照元を保持して理由を出す', async () => {
    const g = gateway(); const f = await fixture(); g.savePcad.mockRejectedValueOnce(new Error('write failed'));
    await savePart(deps, false);
    expect(useAppStore.getState().drawing).toBe(f.document);
    expect(useAppStore.getState().drawingSources).toBe(f.library);
    expect(useAppStore.getState().fileMessage?.failed).toBe(true);
  });
  it('壊れた図面を開いても現在の文書と保存先を保つ', async () => {
    const g = gateway(); const f = await fixture(); g.clearSaveTarget.mockClear();
    await applyPickedDrawing({ name: 'broken.pcadd', bytes: new Uint8Array([1]), saveTargetToken: 'candidate' }, deps);
    expect(useAppStore.getState().drawing).toBe(f.document);
    expect(g.confirmSaveTarget).not.toHaveBeenCalled();
    expect(g.clearSaveTarget).not.toHaveBeenCalled();
  });
  it('保存先の確認に失敗したら前の文書へ上書きしない', async () => {
    const g = gateway(); const f = await fixture();
    g.confirmSaveTarget.mockRejectedValueOnce(new Error('unavailable'));
    const bytes = await writeDrawingBundle(f.document, { source: f.source });
    await applyPickedDrawing({ name: 'valid.pcadd', bytes, saveTargetToken: 'candidate' }, deps);
    expect(useAppStore.getState().drawingFileName).toBe('valid.pcadd');
    expect(g.clearSaveTarget).toHaveBeenCalled();
  });
  it('元文書の一式が無い図面は空の参照元を捏造して保存しない', async () => {
    const g = gateway(); const f = await fixture();
    useAppStore.getState().openDrawing(f.document);
    await savePart(deps, false);
    expect(g.savePcad).not.toHaveBeenCalled();
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'drawing.error.selectSource', failed: true });
  });
});
