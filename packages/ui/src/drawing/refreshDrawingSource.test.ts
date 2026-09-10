import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createEmptyPartDocument, createPartDocumentBundle,
  drawingSourceInputOf, embedDrawingSource, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { readDrawingBundle, writeDrawingBundle, writeDocumentBundle } from '@pointercad/io';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { refreshDrawingSource } from './refreshDrawingSource.js';
import type { FileGateway } from '../file/fileGateway.js';

beforeEach(resetTestStore);
const state = () => useAppStore.getState();
async function setup(kind: 'part' | 'assembly' = 'part') {
  const input = kind === 'part' ? { sourceKind: 'part' as const, document: createEmptyPartDocument(), attachments: emptyEmbeddedPartAttachments() }
    : { sourceKind: 'assembly' as const, document: createAssemblyDocument('元の組立') };
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), input, `original.${kind === 'part' ? 'pcad' : 'pcada'}`, '', { importedAt: '2026-09-10T00:00:00.000Z' });
  const document = { ...createDrawingDocument('保存済みの図面', embedded.source), annotations: [
    { id: 'note', kind: 'note' as const, text: 'この注記は保持', position: [80, 90] as const, height: 3.5, layerId: 'layer-5' },
  ] };
  state().openDrawing(document, { sources: embedded.library, saved: true, fileName: 'drawing.pcadd' });
  const clear = vi.fn(), confirm = vi.fn(), open = vi.fn<FileGateway['openPcad']>();
  state().setFileGateway({ ...state().fileGateway, openPcad: open, hasSaveTarget: () => true, clearSaveTarget: clear, confirmSaveTarget: confirm });
  return { document, input, open, clear, confirm, embedded };
}

describe('元ファイルの取り込み直し', () => {
  it.each(['part', 'assembly'] as const)('%sを正規ファイルから更新し、図面保存先と注記を保ってUndo/Redoする', async (kind) => {
    const { document, input, open, clear, confirm } = await setup(kind);
    const bundle = input.sourceKind === 'part' ? createPartDocumentBundle({ ...input.document, name: '変更した部品' }, input.attachments)
      : createAssemblyDocumentBundle({ ...input.document, name: '変更した組立' });
    open.mockResolvedValue({ name: 'changed.' + (kind === 'part' ? 'pcad' : 'pcada'), bytes: await writeDocumentBundle(bundle), saveTargetToken: 'unconfirmed-source' });
    const version = state().documentVersion;
    expect(await refreshDrawingSource()).toBe(true);
    const next = state().drawing; if (next === null) throw new Error('図面なし');
    const library = state().drawingSources;
    expect(next.source.sourceRef).toBe(document.source.sourceRef); expect(next.source.contentHash).not.toBe(document.source.contentHash);
    expect(next.annotations).toBe(document.annotations); expect(next.dimensions).toBe(document.dimensions);
    expect(state().drawingFileName).toBe('drawing.pcadd'); expect(state().documentVersion).toBe(version + 1);
    expect(clear).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(open).toHaveBeenCalledWith(kind);
    state().undo(); expect(state().drawing).toBe(document);
    state().redo(); expect(state().drawing).toBe(next); expect(state().drawingSources).toBe(library);
    const replacement = drawingSourceInputOf(library.sources[0]);
    if (replacement === null) throw new Error('元文書の種類不一致');
    const reopened = await readDrawingBundle(await writeDrawingBundle(next, { source: replacement }));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.document.annotations).toEqual(document.annotations);
  });
  it('取り消し・破損・種類違いを確定せず、元の図面と保存先を保つ', async () => {
    const { document, open, clear, confirm } = await setup();
    for (const picked of [null, { name: 'broken.pcad', bytes: Uint8Array.of(1), saveTargetToken: 'broken' },
      { name: 'wrong.pcada', bytes: await writeDocumentBundle(createAssemblyDocumentBundle(createAssemblyDocument('違う種類'))), saveTargetToken: 'wrong' }]) {
      open.mockResolvedValue(picked); expect(await refreshDrawingSource()).toBe(false); expect(state().drawing).toBe(document);
    }
    expect(clear).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
  });
  it('同じ内容なら履歴を増やさない', async () => {
    const { document, input, open } = await setup(); if (input.sourceKind !== 'part') throw new Error('部品なし');
    open.mockResolvedValue({ name: 'same.pcad', bytes: await writeDocumentBundle(createPartDocumentBundle(input.document, input.attachments)), saveTargetToken: null });
    const version = state().documentVersion;
    expect(await refreshDrawingSource()).toBe(false); expect(state().drawing).toBe(document); expect(state().documentVersion).toBe(version);
    expect(state().drawingMessage).toContain('変更はありません');
  });
  it('選択中の編集・文書切替・計算開始には古い読込結果を適用しない', async () => {
    for (const change of [() => { const doc = state().drawing; if (doc !== null) state().applyDrawing({ ...doc, name: '変更' }); },
      () => state().closeDrawing(), () => useAppStore.setState({ drawingBusy: true })]) {
      resetTestStore(); const { input, open } = await setup(); if (input.sourceKind !== 'part') throw new Error('部品なし');
      const bytes = await writeDocumentBundle(createPartDocumentBundle({ ...input.document, name: '遅れた元' }, input.attachments));
      open.mockImplementation(() => { change(); return Promise.resolve({ name: 'late.pcad', bytes, saveTargetToken: 'late' }); });
      expect(await refreshDrawingSource()).toBe(false);
      expect(state().drawingSources.sources.some((entry) => entry.document.name === '遅れた元')).toBe(false);
    }
  });
});
