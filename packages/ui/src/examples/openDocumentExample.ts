import { partLibraryOfBundle, type AssemblyExample, type DrawingExample } from '@pointercad/model';
import { activeHasUnsavedChanges } from '../file/assemblyFile.js';
import { beginOpenRequest, finishOpenRequest, mayOpenAfterRead, mayReportOpenFailure } from '../file/documentOpenGuard.js';
import { createDefaultPartFileDeps, type PartFileDeps } from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { prepareDocumentSession, SecurePartIdentityError, type PreparedDocumentSession } from '../store/documentIdentity.js';
import { useAppStore } from '../store/useAppStore.js';
import { ASSEMBLY_EXAMPLE_ENTRIES, DRAWING_EXAMPLE_ENTRIES } from './documentExampleEntries.js';

type DiscardPrompt = Pick<PartFileDeps, 'confirmDiscard'>;

async function openDocumentExample<T>(deps: DiscardPrompt, create: () => Promise<T>,
  apply: (value: T, session: PreparedDocumentSession) => void): Promise<void> {
  if (activeHasUnsavedChanges(useAppStore.getState()) && !(await deps.confirmDiscard('file.discardConfirm'))) return;
  // The request starts once the changes may be lost (documentOpenGuard.ts beginOpenRequest) and is kept through the
  // asynchronous construction of the example, so an edit or a later open in the meantime is caught before applying.
  const request = beginOpenRequest();
  try {
    const value = await create();
    if (!(await mayOpenAfterRead(request, deps)) || !request.isCurrent()) return;
    apply(value, prepareDocumentSession());
  } catch (error) {
    if (mayReportOpenFailure(request)) useAppStore.getState().setFileMessage({
      key: error instanceof SecurePartIdentityError ? 'command.unavailable.action' : 'file.openFailed', failed: true,
    });
  } finally {
    finishOpenRequest(request);
  }
}

export function openAssemblyExample(example: AssemblyExample, deps: DiscardPrompt = createDefaultPartFileDeps()): Promise<void> {
  return openDocumentExample(deps, example.create, (bundle, preparedSession) => {
    const name = t(ASSEMBLY_EXAMPLE_ENTRIES[example.id].nameKey);
    useAppStore.getState().openAssembly({ ...bundle.document, name }, partLibraryOfBundle(bundle), { preparedSession });
  });
}

export function openDrawingExample(example: DrawingExample, deps: DiscardPrompt = createDefaultPartFileDeps()): Promise<void> {
  return openDocumentExample(deps, example.create, ({ document, library }, preparedSession) => {
    const name = t(DRAWING_EXAMPLE_ENTRIES[example.id].nameKey);
    const source = library.sources.find(entry => entry.metadata.sourceRef === document.source.sourceRef
      && entry.metadata.contentHash === document.source.contentHash && entry.metadata.sourceKind === 'part');
    useAppStore.getState().openDrawing({ ...document, name }, { preparedSession, sources: library,
      importedShapes: source?.attachments?.shapes });
  });
}
