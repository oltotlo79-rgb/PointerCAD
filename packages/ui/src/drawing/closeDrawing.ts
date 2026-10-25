import { createDefaultPartFileDeps, type PartFileDeps } from '../file/partFile.js';
import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingSourceInputHash, drawingSourceInputOf, emptyEmbeddedPartAttachments } from '@pointercad/model';
import { loadedPartAttachments } from '../file/loadedPartAttachments.js';

let asking = false;

/** 戻る操作で図面を閉じる前に、未保存の図面を破棄してよいか確認する。 */
export async function closeDrawingWithConfirmation(
  deps: Pick<PartFileDeps, 'confirmDiscard'> = createDefaultPartFileDeps(),
  options: { readonly resumeGuidePart?: boolean } = {},
): Promise<boolean> {
  const before = useAppStore.getState();
  if (before.drawing === null || asking) return false;
  asking = true;
  try {
    if (activeHasUnsavedChanges(before) && !(await deps.confirmDiscard('file.discardConfirm'))) return false;
    const current = useAppStore.getState();
    // 確認に答えている間の別文書・追加編集には、古い破棄の回答を使わない。
    if (current.activeDocumentId !== before.activeDocumentId || current.drawing !== before.drawing
      || current.drawingSources !== before.drawingSources || current.document !== before.document
      || current.documentVersion !== before.documentVersion) return false;
    if (options.resumeGuidePart && (current.tutorialSession !== before.tutorialSession
      || current.tutorialDrawingProof !== before.tutorialDrawingProof
      || current.savedDrawing !== before.savedDrawing
      || current.savedDrawingSources !== before.savedDrawingSources)) return false;
    const session = current.tutorialSession;
    const proof = current.tutorialDrawingProof;
    const guideResume = options.resumeGuidePart === true;
    if (guideResume && (session?.course !== 'parameterToExport' || !proof || current.drawing === null
      || current.savedDrawing !== current.drawing || proof.document !== current.drawing
      || current.drawing.source.sourceKind !== 'part'
      || proof.sourceRef !== current.drawing.source.sourceRef
      || proof.sourceHash !== current.drawing.source.contentHash
      || proof.sourcePart.id !== session.documentId)) return false;
    const coldResume = guideResume && current.document !== proof?.sourcePart;
    const entries = coldResume ? current.drawingSources.sources.filter(item =>
      item.metadata.sourceRef === current.drawing?.source.sourceRef
      && item.metadata.contentHash === current.drawing?.source.contentHash
      && item.metadata.sourceKind === current.drawing?.source.sourceKind) : [];
    if (coldResume && entries.length !== 1) return false;
    const entry = entries[0];
    const source = entry === undefined ? null : drawingSourceInputOf(entry);
    if (coldResume && (source?.sourceKind !== 'part' || proof?.sourcePart !== source.document)) return false;
    let loaded: ReturnType<typeof loadedPartAttachments> | null = null;
    if (coldResume && source?.sourceKind === 'part') {
      try {
        if (await drawingSourceInputHash(source) !== current.drawing?.source.contentHash) return false;
        loaded = loadedPartAttachments(source.document, source.attachments ?? emptyEmbeddedPartAttachments(),
          { shapes: current.importedShapes, meshes: current.importedMeshes, canvases: current.canvases },
          kind => `${kind}-asset-${crypto.randomUUID()}`);
        // A reference rewrite changes the source that the saved drawing proved. Ask for a clean reopen.
        if (loaded.document !== source.document) return false;
      } catch { return false; }
    }
    const verified = useAppStore.getState();
    if (verified.activeDocumentId !== before.activeDocumentId || verified.drawing !== before.drawing
        || verified.drawingSources !== before.drawingSources || verified.tutorialSession !== session
        || verified.tutorialDrawingProof !== proof || verified.savedDrawing !== current.savedDrawing
        || verified.savedDrawingSources !== current.savedDrawingSources
        || verified.importedShapes !== current.importedShapes || verified.importedMeshes !== current.importedMeshes
        || verified.canvases !== current.canvases || verified.document !== before.document
        || verified.documentVersion !== before.documentVersion) return false;
    current.closeDrawing();
    const returned = useAppStore.getState();
    if (coldResume && source?.sourceKind === 'part' && session !== null && loaded !== null) {
      // Match ordinary .pcad open: register the validated attachments before applying the part.
      // Opening another part starts a new history and selection, like openPart: an Undo must not
      // bring back the previous part while the guide and file state describe the reopened one.
      returned.setImportedAttachments(loaded.attachments.shapes, loaded.attachments.meshes);
      returned.setCanvasImages(loaded.attachments.canvases);
      returned.applyDocument(loaded.document, { opensDocument: true });
      const resumed = useAppStore.getState();
      resumed.setImportedAttachments(loaded.attachments.shapes, loaded.attachments.meshes);
      resumed.setCanvasImages(loaded.attachments.canvases);
      resumed.setFileState(null, loaded.document);
      resumed.setTutorialSession({ ...session, documentVersion: resumed.documentVersion });
      resumed.setTutorialDrawingProof({ document: before.drawing, sourcePart: loaded.document,
        sourceRef: before.drawing.source.sourceRef, sourceHash: before.drawing.source.contentHash });
      return true;
    }
    if (session?.course === 'parameterToExport' && session.documentId === before.document.id
        && session.documentVersion === before.documentVersion && returned.document === before.document) {
      returned.setTutorialSession({ ...session, documentVersion: returned.documentVersion });
    }
    return true;
  } finally { asking = false; }
}
