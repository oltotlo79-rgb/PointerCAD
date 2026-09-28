/** 図面と参照元一式を、文書ごとの保存キューを通して開く・保存する。 */
import { readDrawingBundle, writeDrawingBundle } from '@pointercad/io';
import { drawingSourceInputOf } from '@pointercad/model';
import type { DocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginOpenRequest, mayOpenAfterRead, mayReportOpenFailure } from './documentOpenGuard.js';
import { completeDocumentSave, queueDocumentSave } from './documentSaveQueue.js';
import { withPcaddExtension, type PickedFile } from './fileGateway.js';
import { openErrorMessageKey, type PartFileDeps } from './partFile.js';
import { recordRecentFile } from './recentFiles.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { saveFailureMessageKey } from './saveFailure.js';

/**
 * 図面を開く。読込の間の変化は版の番号だけでなく文書の参照で調べる(版は通常の編集で
 * 増えないため。docs/review-2026-09-28-codex.md R01 の注意)。扱いは `mayOpenAfterRead`。
 */
export async function applyPickedDrawing(
  picked: PickedFile,
  deps: PartFileDeps,
  request: DocumentRequest = beginOpenRequest(),
): Promise<void> {
  const result = await readDrawingBundle(picked.bytes);
  if (!result.ok) {
    if (mayReportOpenFailure(request)) {
      useAppStore.getState().setFileMessage({ key: openErrorMessageKey(result.error.code), failed: true });
    }
    return;
  }
  if (!(await mayOpenAfterRead(request, deps))) return;
  const before = useAppStore.getState();
  before.openDrawing(result.document, { saved: true, fileName: picked.name, preserveSaveTarget: true,
    sources: { sources: [{ metadata: result.document.source, ...result.source }] },
    importedShapes: result.source.sourceKind === 'part' ? result.source.attachments?.shapes : undefined });
  const openedId = useAppStore.getState().activeDocumentId;
  try {
    if (picked.saveTargetToken === null) before.fileGateway.clearSaveTarget?.();
    else await before.fileGateway.confirmSaveTarget?.(picked.saveTargetToken);
  } catch {
    if (useAppStore.getState().activeDocumentId === openedId) before.fileGateway.clearSaveTarget?.();
  }
  if (useAppStore.getState().activeDocumentId === openedId) recordRecentFile(picked.name, { storage: deps.recentFilesStorage });
}

export async function saveDrawing(deps: PartFileDeps, saveAs: boolean): Promise<void> {
  const before = useAppStore.getState();
  const drawing = before.drawing;
  if (drawing === null) return;
  const entry = before.drawingSources.sources.find((item) => item.metadata.sourceRef === drawing.source.sourceRef
    && item.metadata.contentHash === drawing.source.contentHash);
  const source = entry === undefined ? null : drawingSourceInputOf(entry);
  if (source === null) {
    before.setFileMessage({ key: 'drawing.error.selectSource', failed: true });
    return;
  }
  return queueDocumentSave(before, async (isCurrent) => {
    try {
      const bytes = await writeDrawingBundle(drawing, { source });
      if (!isCurrent()) return;
      const saved = await before.fileGateway.savePcad(withPcaddExtension(before.drawingFileName ?? drawing.name),
        bytes, saveAs || !before.fileGateway.hasSaveTarget(), 'drawing');
      if (saved === null || !isCurrent()) return;
      const name = withPcaddExtension(saved);
      before.setDrawingFileState(name, drawing, before.drawingSources);
      recordRecentFile(name, { storage: deps.recentFilesStorage });
      const mayClear = () => isCurrent() && useAppStore.getState().autoSaver === before.autoSaver
        && !activeHasUnsavedChanges(useAppStore.getState());
      await completeDocumentSave(isCurrent, async () => {
        if (mayClear() && before.autoSaver !== null) {
          await before.autoSaver.discard();
          const record = before.recoveryRecord;
          if (mayClear() && record?.kind === 'drawing' && record.documentId === before.activeDocumentId && record.sessionId !== undefined) {
            await before.autoSaver.discard({ kind: 'drawing', documentId: record.documentId, sessionId: record.sessionId });
            if (mayClear() && useAppStore.getState().recoveryRecord === record) useAppStore.setState({ recoveryRecord: null });
          }
        }
      });
    } catch (error) {
      if (isCurrent()) before.setFileMessage({ key: saveFailureMessageKey(error), failed: true });
    }
  });
}
