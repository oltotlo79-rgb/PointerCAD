import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readDrawingBundle, writeDrawingBundle } from '@pointercad/io';
import { createDrawingDocument, createEmptyPartDocument, embedDrawingSource, emptyDrawingSourceLibrary } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyPickedDrawing } from './drawingFile.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { openPart, savePart, type PartFileDeps } from './partFile.js';
import type { FileGateway, PickedFile } from './fileGateway.js';

beforeEach(resetTestStore);
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
    const g = gateway(); await fixture(); const write = deferred<string | null>();
    g.savePcad.mockReturnValueOnce(write.promise);
    const saving = savePart(deps, false);
    await vi.waitFor(() => expect(g.savePcad).toHaveBeenCalledOnce());
    const next = await fixture();
    write.resolve('old.pcadd'); await saving;
    expect(useAppStore.getState().drawing).toBe(next.document);
    expect(useAppStore.getState().drawingFileName).toBeNull();
    expect(useAppStore.getState().savedDrawing).toBeNull();
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
    const g = gateway(); await fixture(); g.savePcad.mockResolvedValueOnce(null);
    await savePart(deps, false);
    expect(useAppStore.getState().savedDrawing).toBeNull();
    expect(useAppStore.getState().drawingFileName).toBeNull();
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
