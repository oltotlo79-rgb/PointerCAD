import { readDocumentBundle, type ReadDocumentBundleResult } from '@pointercad/io';
import {
  embedPart,
  findComponent,
  type EmbedPartResult,
  type EmbeddedPartAttachments,
  type PartDocument,
  type PartLibrary,
} from '@pointercad/model';
import {
  openFileThrough,
  type FileGateway,
  type PickedFile,
  type PickedTypedFile,
} from '../file/fileGateway.js';
import { openErrorMessageKey } from '../file/partFile.js';
import { useAppStore } from '../store/useAppStore.js';
import { cancelMate } from './mateActions.js';
import {
  confirmComponentReplacement,
  placeSubAssemblyBundle,
  prepareComponentReplacement,
} from './replaceCommands.js';

export interface PlaceSubAssemblyDeps {
  readonly choose: (gateway: FileGateway) => Promise<PickedFile | null>;
  readonly read: (bytes: Uint8Array) => Promise<ReadDocumentBundleResult>;
}

const SUB_ASSEMBLY_DEPS: PlaceSubAssemblyDeps = {
  choose: (gateway) => gateway.openPcad('assembly'),
  read: (bytes) => readDocumentBundle(bytes, 'assembly'),
};

export interface ReplaceComponentDeps {
  readonly choose: (gateway: FileGateway) => Promise<PickedTypedFile | null>;
  readonly read: (bytes: Uint8Array) => Promise<ReadDocumentBundleResult>;
  readonly embed: (
    library: PartLibrary,
    document: PartDocument,
    fileName: string,
    attachments: EmbeddedPartAttachments,
  ) => Promise<EmbedPartResult>;
}

const REPLACEMENT_DEPS: ReplaceComponentDeps = {
  choose: (gateway) => openFileThrough(gateway, ['pcad']),
  read: (bytes) => readDocumentBundle(bytes, 'part'),
  embed: (library, document, fileName, attachments) =>
    embedPart(library, document, fileName, '', { attachments }),
};

function currentRequest(
  requestId: string,
  documentId: string,
  assembly: NonNullable<ReturnType<typeof useAppStore.getState>['assembly']>,
  library: PartLibrary,
): boolean {
  const state = useAppStore.getState();
  return state.assemblyReplacementRequestId === requestId
    && state.activeDocumentId === documentId
    && state.assembly === assembly
    && state.assemblyLibrary === library;
}

function finishRequest(requestId: string): void {
  if (useAppStore.getState().assemblyReplacementRequestId === requestId) {
    useAppStore.setState({ assemblyReplacementBusy: false, assemblyReplacementRequestId: null });
  }
}

/** `.pcada` を選び、参照一式を衝突しない名前へ写して1回のUndoで置く。 */
export async function startPlaceSubAssembly(
  deps: PlaceSubAssemblyDeps = SUB_ASSEMBLY_DEPS,
): Promise<void> {
  const before = useAppStore.getState();
  if (before.assembly === null || before.assemblyReplacementBusy) return;
  cancelMate();
  const assembly = before.assembly;
  const library = before.assemblyLibrary;
  const documentId = before.activeDocumentId;
  const requestId = crypto.randomUUID();
  useAppStore.setState({ assemblyReplacementBusy: true, assemblyReplacementRequestId: requestId,
    assemblyReplacementPreview: null });
  try {
    const picked = await deps.choose(before.fileGateway);
    if (!currentRequest(requestId, documentId, assembly, library) || picked === null) return;
    const read = await deps.read(picked.bytes);
    if (!currentRequest(requestId, documentId, assembly, library)) return;
    if (!read.ok || read.bundle.kind !== 'assembly') {
      useAppStore.getState().setFileMessage({
        key: read.ok ? 'file.openFailed' : openErrorMessageKey(read.error.code),
        failed: true,
      });
      return;
    }
    const currentFileDocument = before.assemblyFileName !== null
      && before.assemblyFileName === picked.name
      ? before.savedAssembly?.document
      : undefined;
    const placed = placeSubAssemblyBundle(assembly, library, read.bundle, currentFileDocument);
    if (!placed.ok) {
      useAppStore.setState({ errorMessage: placed.message });
      return;
    }
    const current = useAppStore.getState();
    current.applyAssembly(placed.document, placed.library);
    current.setSelection([placed.component.id]);
  } catch {
    if (currentRequest(requestId, documentId, assembly, library)) {
      useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    }
  } finally {
    finishRequest(requestId);
  }
}

/** 選択部品の新しい形を計算し、必要な場合だけ非モーダル予告を開く。 */
export async function startReplaceSelectedComponent(
  deps: ReplaceComponentDeps = REPLACEMENT_DEPS,
): Promise<void> {
  const before = useAppStore.getState();
  const assembly = before.assembly;
  if (assembly === null || before.assemblyReplacementBusy || before.assemblyReplacementRunner === null) return;
  const selected = before.selection.filter((id) => findComponent(assembly, id) !== undefined);
  const componentId = selected.length === 1 ? selected[0] : undefined;
  if (componentId === undefined) return;
  cancelMate();
  const library = before.assemblyLibrary;
  const runner = before.assemblyReplacementRunner;
  const documentId = before.activeDocumentId;
  const requestId = crypto.randomUUID();
  useAppStore.setState({ assemblyReplacementBusy: true, assemblyReplacementRequestId: requestId,
    assemblyReplacementPreview: null });
  try {
    const picked = await deps.choose(before.fileGateway);
    if (!currentRequest(requestId, documentId, assembly, library) || picked === null) return;
    const read = await deps.read(picked.bytes);
    if (!currentRequest(requestId, documentId, assembly, library)) return;
    if (!read.ok || read.bundle.kind !== 'part') {
      useAppStore.getState().setFileMessage({
        key: read.ok ? 'file.openFailed' : openErrorMessageKey(read.error.code), failed: true,
      });
      return;
    }
    const embedded = await deps.embed(library, read.bundle.document, picked.fileName, read.bundle.attachments);
    if (!currentRequest(requestId, documentId, assembly, library)) return;
    const bodies = await runner.resolve(read.bundle.document, read.bundle.attachments, requestId);
    if (!currentRequest(requestId, documentId, assembly, library)) return;
    const prepared = prepareComponentReplacement(
      assembly,
      componentId,
      { kind: 'part', partRef: embedded.partRef },
      bodies,
    );
    if (prepared === null) return;
    if (!prepared.requiresConfirmation) {
      const current = useAppStore.getState();
      current.applyAssembly(confirmComponentReplacement(prepared), embedded.library);
      current.setSelection([componentId]);
      return;
    }
    useAppStore.setState({
      assemblyReplacementPreview: { documentId, prepared, library: embedded.library },
    });
  } catch {
    if (currentRequest(requestId, documentId, assembly, library)) {
      useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
    }
  } finally {
    finishRequest(requestId);
  }
}

export function confirmReplacementPreview(): void {
  const state = useAppStore.getState();
  const preview = state.assemblyReplacementPreview;
  if (preview === null || state.activeDocumentId !== preview.documentId
    || state.assembly !== preview.prepared.plan.before) return;
  const componentId = preview.prepared.plan.componentId;
  state.applyAssembly(confirmComponentReplacement(preview.prepared), preview.library);
  useAppStore.getState().setSelection([componentId]);
}

export function cancelReplacementPreview(): void {
  useAppStore.setState({ assemblyReplacementPreview: null });
}
