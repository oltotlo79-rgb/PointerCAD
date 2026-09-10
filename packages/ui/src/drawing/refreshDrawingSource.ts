import { readDocumentBundle } from '@pointercad/io';
import { partLibraryOfBundle, replaceSource, type DrawingSourceInput } from '@pointercad/model';
import { openErrorMessageKey } from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

/** 元のファイルだけを取り込み直す。図面の保存先は確定・解除しない。 */
export async function refreshDrawingSource(): Promise<boolean> {
  const before = useAppStore.getState(), drawing = before.drawing;
  if (drawing === null || before.drawingBusy) return false;
  const current = (): boolean => {
    const state = useAppStore.getState();
    return state.activeDocumentId === before.activeDocumentId && state.documentVersion === before.documentVersion
      && state.drawing === drawing && state.drawingSources === before.drawingSources && !state.drawingBusy;
  };
  try {
    const picked = await before.fileGateway.openPcad(drawing.source.sourceKind);
    if (picked === null || !current()) return false;
    const read = await readDocumentBundle(picked.bytes, drawing.source.sourceKind);
    if (!current()) return false;
    if (!read.ok) { before.setDrawingMessage(t(openErrorMessageKey(read.error.code))); return false; }
    const bundle = read.bundle;
    const input: DrawingSourceInput = bundle.kind === 'part'
      ? { sourceKind: 'part', document: bundle.document, attachments: bundle.attachments }
      : { sourceKind: 'assembly', document: bundle.document, library: partLibraryOfBundle(bundle) };
    if (input.sourceKind !== drawing.source.sourceKind) { before.setDrawingMessage(t('drawing.sourceRefresh.kind')); return false; }
    const next = await replaceSource(drawing, before.drawingSources, input);
    if (!current()) return false;
    if (next === null) { before.setDrawingMessage(t('drawing.error.selectSource')); return false; }
    if (next.document.source.contentHash === drawing.source.contentHash) {
      before.setDrawingMessage(t('drawing.sourceRefresh.unchanged')); return false;
    }
    const metadata = { ...next.document.source, fileName: picked.name };
    before.applyDrawing({ ...next.document, source: metadata }, { sources: next.library.sources.map((entry) =>
      entry.metadata.sourceRef === metadata.sourceRef ? { ...entry, metadata } : entry) });
    before.selectDrawingIds([]); before.setDrawingMessage(t('drawing.sourceRefresh.updated')); return true;
  } catch {
    if (current()) before.setDrawingMessage(t('file.openFailed'));
    return false;
  }
}
