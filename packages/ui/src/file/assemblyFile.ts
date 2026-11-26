import { awaitThumbnailCapture } from './thumbnail.js';
import { captureDocumentIdentity, compareDocumentIdentity } from '../store/documentRequest.js';
/** アセンブリの文書・添付・保存先を一緒に開閉する。 */
import { writeAssemblyDocument } from '@pointercad/io';
import { createAssemblyDocument, createAssemblyDocumentBundle, partLibraryOfBundle,
  type AssemblyDocument, type PartLibrary } from '@pointercad/model';
import { activeDocument } from '../store/documentKind.js';
import type { AppState } from '../store/appState.js';
import type { AssemblySnapshot } from '../store/assemblySlice.js';
import type { DocumentRequest } from '../store/documentRequest.js';
import { useAppStore } from '../store/useAppStore.js';
import { prepareDocumentSession, SecurePartIdentityError, type PreparedDocumentSession } from '../store/fileSlice.js';
import { t } from '../i18n/t.js';
import { beginOpenRequest, finishOpenRequest, mayOpenAfterRead, mayReportOpenFailure, pickForOpen, readPickedForOpen } from './documentOpenGuard.js';
import { savePcadThrough, withPcadaExtension, type PickedNativeFile } from './fileGateway.js';
import type { PartFileDeps } from './partFile.js';
import { openErrorMessage } from './documentReadError.js';
import { hasUnsavedChanges } from './partDocumentDirty.js';
import { recordRecentFile } from './recentFiles.js';
import { saveFailureMessageKey } from './saveFailure.js';
import { completeDocumentSave, queueDocumentSave, reportSaveEncodingFailure } from './documentSaveQueue.js';
import { savedMessageKey, type SaveResultIssueReport } from './saveResultIssue.js';
import { encodeSaveParts } from './pcadSaveWorker.js';
import { captureSaveSnapshot } from './pcadSaveSnapshot.js';
import { analysisResultsToSave } from '../beam/savedBeamResults.js';

const contentCache = new WeakMap<AssemblyDocument, WeakMap<PartLibrary, string>>();

function content(snapshot: AssemblySnapshot): string {
  let byLibrary = contentCache.get(snapshot.document);
  const cached = byLibrary?.get(snapshot.library);
  if (cached !== undefined) return cached;
  const value = writeAssemblyDocument(snapshot.document, {
    partFiles: snapshot.library.partFiles, savedAt: '1970-01-01T00:00:00.000Z',
  });
  if (byLibrary === undefined) {
    byLibrary = new WeakMap();
    contentCache.set(snapshot.document, byLibrary);
  }
  byLibrary.set(snapshot.library, value);
  return value;
}

/** 共通の文書入口を使い、見えている文書だけを判定する。 */
export function activeHasUnsavedChanges(state: AppState): boolean {
  const active = activeDocument(state);
  if (active.kind === 'part') return hasUnsavedChanges(active.document, active.saved);
  if (active.kind === 'drawing') return active.saved === null
    ? active.document.views.length > 0 || active.document.dimensions.length > 0 || active.document.annotations.length > 0
      || active.document.tables.length > 0 || active.document.balloons.length > 0 || active.document.parameters.length > 0
      || active.document.datums.length > 0 || active.document.gdtFrames.length > 0 || active.document.weldSymbols.length > 0
      || (state.drawingUndoStack?.past.length ?? 0) > 0 || active.document.name !== active.initialName
    : active.document !== active.saved || state.drawingSources !== state.savedDrawingSources;
  if (active.saved === null) return active.document.components.length > 0 ||
    active.library.partFiles.length > 0 ||
    active.document.name !== (active.initialName ?? active.document.name) ||
    writeAssemblyDocument(active.document, { savedAt: '' }) !==
      writeAssemblyDocument(createAssemblyDocument(active.document.name), { savedAt: '' });
  if (active.document === active.saved.document && active.library === active.saved.library) return false;
  return content({ document: active.document, library: active.library }) !== content(active.saved);
}

export async function newAssembly(deps: PartFileDeps): Promise<void> {
  if (activeHasUnsavedChanges(useAppStore.getState()) && !(await deps.confirmDiscard('file.discardConfirm'))) return;
  const store = useAppStore.getState();
  let preparedSession: PreparedDocumentSession;
  try { preparedSession = prepareDocumentSession(); }
  catch (error) {
    if (!(error instanceof SecurePartIdentityError)) throw error;
    store.setFileMessage({ key: 'command.unavailable.action', failed: true });
    return;
  }
  store.openAssembly(createAssemblyDocument(t('assembly.untitled')), undefined, { preparedSession });
}

/**
 * 検証と適用が済むまで保存先を確定しない。失敗・取消は今の文書を保つ。
 *
 * `request` は破棄の確認に答えた時点の札(`beginOpenRequest`)。読込の間に文書が変わったら
 * `mayOpenAfterRead` が改めて確認するか、開くのをやめる(組立を開くと取り消しの履歴を
 * 作り直すため、確認なしに置き換えると読込中の編集を取り戻せない)。
 */
export async function applyPickedAssembly(
  picked: PickedNativeFile,
  deps: PartFileDeps,
  request: DocumentRequest = beginOpenRequest(),
): Promise<void> {
  try {
  // 組立は読込の後に picked.bytes を読まない(学習の控えも無い)ので、自分だけの並びなら写さずに移す。
  const read = await readPickedForOpen(request, 'assembly', picked, 'bytes' in picked && picked.owned === true);
  if (read === null) return;
  const { result, saveTargetToken } = read;
  if (!result.ok) {
    if (mayReportOpenFailure(request)) {
      useAppStore.getState().setFileMessage({ ...openErrorMessage(result.error), failed: true });
    }
    return;
  }
  if (result.bundle.kind !== 'assembly') return;
  if (!(await mayOpenAfterRead(request, deps))) return;
  const before = useAppStore.getState();
  const library = partLibraryOfBundle(result.bundle);
  before.openAssembly(result.bundle.document, library, { preserveSaveTarget: true, analysisResults: result.bundle.analysisResults,
    analysisResultsDropped: result.analysisResultIssue !== undefined });
  const openedId = useAppStore.getState().activeDocumentId;
  before.setAssemblyFileState(picked.name, { document: result.bundle.document, library });
  try {
    if (saveTargetToken === null) before.fileGateway.clearSaveTarget?.();
    else await before.fileGateway.confirmSaveTarget?.(saveTargetToken);
  } catch {
    // 確定を待つ間に別の文書へ切り替わったら、その文書の保存先には触らない(図面を開くのと同じ)。
    if (useAppStore.getState().activeDocumentId === openedId) before.fileGateway.clearSaveTarget?.();
  }
  if (useAppStore.getState().activeDocumentId === openedId) {
    recordRecentFile(picked.name, { storage: deps.recentFilesStorage });
  }
  } finally { finishOpenRequest(request); }
}

export async function openAssembly(deps: PartFileDeps): Promise<void> {
  if (activeHasUnsavedChanges(useAppStore.getState()) && !(await deps.confirmDiscard('file.discardConfirm'))) return;
  // ファイルを選ぶ窓の間の変更も、確認に答えた時点と比べる。
  const request = beginOpenRequest();
  try {
    const picked = await pickForOpen(request, 'assembly');
    if (picked !== null) await applyPickedAssembly(picked, deps, request);
  } catch {
    if (mayReportOpenFailure(request)) useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
  } finally { finishOpenRequest(request); }
}

export async function saveAssembly(deps: PartFileDeps, saveAs: boolean): Promise<void> {
  const before = useAppStore.getState();
  const active = activeDocument(before);
  if (active.kind !== 'assembly') return;
  const snapshot = { document: active.document, library: active.library };
  const thumbnailIdentity = captureDocumentIdentity(before);
  const thumbnail = Promise.resolve(deps.captureThumbnail()).catch(() => null);
  const encoding = captureSaveSnapshot({ kind: 'assembly',
    bundle: createAssemblyDocumentBundle(active.document, active.library, analysisResultsToSave(before, active.document)),
    options: { savedAt: new Date().toISOString() } });
  const resultIssues: SaveResultIssueReport[] = [];
  return queueDocumentSave(before, async (isCurrent, control) => {
  try {
    const captured = await awaitThumbnailCapture(thumbnail, control.signal);
    if (!isCurrent()) return;
    const current = useAppStore.getState();
    const thumbnailPng = compareDocumentIdentity(thumbnailIdentity, current) === 'current'
      && current.requestedGeneration === before.requestedGeneration && current.completedGeneration === before.completedGeneration
      && current.cancelRequestCount === before.cancelRequestCount && current.recomputeCancelled === before.recomputeCancelled ? captured : null;
    const withThumbnail = encoding.kind === 'assembly' && thumbnailPng !== null
      ? { ...encoding, options: { ...encoding.options, thumbnailPng } } : encoding;
    // A beam result the writer leaves out is named in the saved notice, as for a part (saveResultIssue.ts).
    const parts = await encodeSaveParts(deps.encodeSave ?? before.saveDocumentEncoder, withThumbnail,
      { ...control, onAnalysisResultIssue: (analysisId, issue) => { resultIssues.push({ analysisId, issue }); } });
    if (!control.beginWriting()) return;
    const saved = await savePcadThrough(before.fileGateway,
      withPcadaExtension(active.fileName ?? active.document.name ?? t('assembly.untitled')),
      parts, saveAs || !before.fileGateway.hasSaveTarget(), 'assembly');
    if (saved === null || !isCurrent()) return;
    const name = withPcadaExtension(saved);
    before.setAssemblyFileState(name, snapshot);
    recordRecentFile(name, { storage: deps.recentFilesStorage });
    await completeDocumentSave(isCurrent, async () => {
      if (useAppStore.getState().autoSaver === before.autoSaver && !activeHasUnsavedChanges(useAppStore.getState())) {
        await before.autoSaver?.discard();
        if (isCurrent() && useAppStore.getState().autoSaver === before.autoSaver && !activeHasUnsavedChanges(useAppStore.getState())) {
          useAppStore.setState({ recoverySaveState: null });
        }
      }
    }, name, savedMessageKey(resultIssues));
  } catch (error) {
    if (isCurrent()) {
      before.setFileMessage({ key: saveFailureMessageKey(error), failed: true });
      reportSaveEncodingFailure(error, isCurrent);
    }
  }
  });
}
