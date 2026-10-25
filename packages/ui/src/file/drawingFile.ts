/** 図面と参照元一式を、文書ごとの保存キューを通して開く・保存する。 */
import { readDrawingBundle } from '@pointercad/io';
import { drawingSourceInputHash, drawingSourceInputOf } from '@pointercad/model';
import type { DocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginOpenRequest, mayOpenAfterRead, mayReportOpenFailure } from './documentOpenGuard.js';
import { completeDocumentSave, queueDocumentSave, reportSaveEncodingFailure } from './documentSaveQueue.js';
import { captureSaveSnapshot } from './pcadSaveSnapshot.js';
import { withPcaddExtension, type PickedFile } from './fileGateway.js';
import { openErrorMessageKey, type PartFileDeps } from './partFile.js';
import { recordRecentFile } from './recentFiles.js';
import { activeHasUnsavedChanges } from './assemblyFile.js';
import { saveFailureMessageKey } from './saveFailure.js';
import { readTutorialCheckpoint, saveTutorialCheckpoint } from '../tutorial/tutorialCheckpoint.js';
import { continuingParameterSession, parameterCheckpointIdentity, parameterCheckpointInput,
  parameterCheckpointWriteGuard, resumeParameterTutorialSession } from '../tutorial/tutorialProgress.js';

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
  const checkpoint = result.source.sourceKind === 'part'
    ? await readTutorialCheckpoint({ part: { document: result.source.document }, drawing: {
      document: result.document, source: result.source, savedBytes: picked.bytes,
    } }, useAppStore.getState().tutorialCheckpointStorage)
    : null;
  if (!(await mayOpenAfterRead(request, deps))) return;
  const before = useAppStore.getState();
  before.openDrawing(result.document, { saved: true, fileName: picked.name, preserveSaveTarget: true,
    sources: { sources: [{ metadata: result.document.source, ...result.source }] },
    importedShapes: result.source.sourceKind === 'part' ? result.source.attachments?.shapes : undefined });
  const opened = useAppStore.getState();
  opened.setTutorialDrawingProof(null);
  opened.setTutorialExports({});
  opened.setTutorialDraft(checkpoint?.ok ? checkpoint.checkpoint.draft ?? null : null);
  opened.setTutorialCheckpointFailure(checkpoint === null || checkpoint.ok || checkpoint.reason === 'missing'
    ? null : checkpoint.reason);
  if (checkpoint?.ok && result.source.sourceKind === 'part') {
    opened.setTutorialSession(resumeParameterTutorialSession(checkpoint.checkpoint,
      result.source.document, opened.documentVersion));
    opened.setTutorialDrawingProof({ document: result.document, sourcePart: result.source.document,
      sourceRef: result.document.source.sourceRef, sourceHash: result.document.source.contentHash });
  } else {
    opened.setTutorialSession(null);
  }
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
  const snapshot = captureSaveSnapshot({ kind: 'drawing', document: drawing, options: { source, savedAt: new Date().toISOString() } });
  const provenColdSource = before.tutorialDrawingProof?.document === before.savedDrawing
    && before.tutorialDrawingProof.sourcePart === (source.sourceKind === 'part' ? source.document : null);
  const guideSession = before.tutorialSession?.course === 'parameterToExport'
    && source.sourceKind === 'part' && source.document.id === before.tutorialSession.documentId
    && before.tutorialSession.documentVersion === before.documentVersion
    && (source.document === before.document || provenColdSource)
    ? before.tutorialSession : null;
  const guideVersion = before.documentVersion;
  return queueDocumentSave(before, async (isCurrent, control) => {
    try {
      const bytes = await (deps.encodeSave ?? before.saveDocumentEncoder)(snapshot, control);
      if (!control.beginWriting()) return;
      const saved = await before.fileGateway.savePcad(withPcaddExtension(before.drawingFileName ?? drawing.name),
        bytes, saveAs || !before.fileGateway.hasSaveTarget(), 'drawing');
      if (saved === null || !isCurrent()) return;
      const name = withPcaddExtension(saved);
      before.setDrawingFileState(name, drawing, before.drawingSources);
      if (guideSession !== null && source.sourceKind === 'part') {
        const latest = useAppStore.getState();
        const activeGuide = latest.tutorialSession;
        if (continuingParameterSession(guideSession, activeGuide) && activeGuide !== null) {
          const currentGuide = () => isCurrent() && useAppStore.getState().drawing === drawing
            && useAppStore.getState().documentVersion === guideVersion
            && useAppStore.getState().tutorialCheckpointStorage === before.tutorialCheckpointStorage
            && useAppStore.getState().tutorialSession === activeGuide;
          if (currentGuide()) {
            const input = parameterCheckpointInput(activeGuide, source.document, 'stepStl');
            if (input !== null) {
              const guard = parameterCheckpointWriteGuard(activeGuide, before.tutorialCheckpointStorage, currentGuide);
              const checkpoint = guard.ok ? await saveTutorialCheckpoint(input, { part: { document: source.document },
                drawing: { document: drawing, source, savedBytes: bytes } },
                before.tutorialCheckpointStorage, guard.isCurrent) : guard;
              if (currentGuide()) useAppStore.getState().setTutorialCheckpointFailure(checkpoint.ok ? null : checkpoint.reason);
              let sourceValid = false;
              if (currentGuide()) {
                try { sourceValid = drawing.source.contentHash === await drawingSourceInputHash(source); }
                catch { sourceValid = false; }
              }
              if (sourceValid && currentGuide()) useAppStore.getState().setTutorialDrawingProof({
                document: drawing, sourcePart: source.document,
                sourceRef: drawing.source.sourceRef, sourceHash: drawing.source.contentHash,
              });
              if (checkpoint.ok && currentGuide()) useAppStore.getState().setTutorialSession({ ...activeGuide,
                checkpointIdentity: parameterCheckpointIdentity(checkpoint.checkpoint) });
            }
          }
        }
      }
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
          if (mayClear()) useAppStore.setState({ recoverySaveState: null });
        }
      }, name);
    } catch (error) {
      if (isCurrent()) before.setFileMessage({ key: saveFailureMessageKey(error), failed: true });
      reportSaveEncodingFailure(error, isCurrent);
    }
  });
}
