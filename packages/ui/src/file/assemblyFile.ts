/** アセンブリの文書・添付・保存先を一緒に開閉する。 */
import { readDocumentBundle, writeAssemblyDocument, writeDocumentBundle } from '@pointercad/io';
import { createAssemblyDocument, createAssemblyDocumentBundle, partLibraryOfBundle,
  type AssemblyDocument, type PartLibrary } from '@pointercad/model';
import { activeDocument } from '../store/documentKind.js';
import type { AppState } from '../store/appState.js';
import type { AssemblySnapshot } from '../store/assemblySlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { withPcadaExtension, type PickedFile } from './fileGateway.js';
import { hasUnsavedChanges, openErrorMessageKey, type PartFileDeps } from './partFile.js';
import { recordRecentFile } from './recentFiles.js';
import { saveFailureMessageKey } from './saveFailure.js';
import { queueDocumentSave } from './documentSaveQueue.js';

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
  useAppStore.getState().openAssembly(createAssemblyDocument(t('assembly.untitled')));
}

/** 検証と適用が済むまで保存先を確定しない。失敗・取消は今の文書を保つ。 */
export async function applyPickedAssembly(picked: PickedFile, deps: PartFileDeps): Promise<void> {
  const before = useAppStore.getState();
  const identity = before.activeDocumentId;
  const result = await readDocumentBundle(picked.bytes, 'assembly');
  if (useAppStore.getState().activeDocumentId !== identity) return;
  if (!result.ok) {
    before.setFileMessage({ key: openErrorMessageKey(result.error.code), failed: true });
    return;
  }
  if (result.bundle.kind !== 'assembly') return;
  const library = partLibraryOfBundle(result.bundle);
  before.openAssembly(result.bundle.document, library, { preserveSaveTarget: true });
  const openedId = useAppStore.getState().activeDocumentId;
  before.setAssemblyFileState(picked.name, { document: result.bundle.document, library });
  try {
    if (picked.saveTargetToken === null) before.fileGateway.clearSaveTarget?.();
    else await before.fileGateway.confirmSaveTarget?.(picked.saveTargetToken);
  } catch {
    before.fileGateway.clearSaveTarget?.();
  }
  if (useAppStore.getState().activeDocumentId === openedId) {
    recordRecentFile(picked.name, { storage: deps.recentFilesStorage });
  }
}

export async function openAssembly(deps: PartFileDeps): Promise<void> {
  if (activeHasUnsavedChanges(useAppStore.getState()) && !(await deps.confirmDiscard('file.discardConfirm'))) return;
  try {
    const picked = await useAppStore.getState().fileGateway.openPcad('assembly');
    if (picked !== null) await applyPickedAssembly(picked, deps);
  } catch {
    useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
  }
}

export async function saveAssembly(deps: PartFileDeps, saveAs: boolean): Promise<void> {
  const before = useAppStore.getState();
  const active = activeDocument(before);
  if (active.kind !== 'assembly') return;
  const snapshot = { document: active.document, library: active.library };
  return queueDocumentSave(before, async (isCurrent) => {
  try {
    const thumbnailPng = deps.captureThumbnail();
    const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(active.document, active.library),
      thumbnailPng === null ? {} : { thumbnailPng });
    if (!isCurrent()) return;
    const saved = await before.fileGateway.savePcad(
      withPcadaExtension(active.fileName ?? active.document.name ?? t('assembly.untitled')),
      bytes, saveAs || !before.fileGateway.hasSaveTarget(), 'assembly');
    if (saved === null || !isCurrent()) return;
    const name = withPcadaExtension(saved);
    before.setAssemblyFileState(name, snapshot);
    before.setFileMessage({ key: 'file.saved', failed: false });
    recordRecentFile(name, { storage: deps.recentFilesStorage });
    if (useAppStore.getState().autoSaver === before.autoSaver && !activeHasUnsavedChanges(useAppStore.getState())) {
      try { await before.autoSaver?.discard(); } catch { /* ファイル自体の保存は成功済み。 */ }
    }
  } catch (error) {
    if (isCurrent()) {
      before.setFileMessage({ key: saveFailureMessageKey(error), failed: true });
    }
  }
  });
}
