import { activeAssemblyDocument } from '../store/documentKind.js';
import { readDocumentBundle, type ReadDocumentBundleResult } from '@pointercad/io';
import {
  embedPart,
  MAX_SUB_ASSEMBLY_DEPTH,
  type AssemblyDocument,
  replacePartDocument,
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

/** Counts saved occurrences, including hidden and suppressed branches. */
export function sharedPartOccurrenceCount(
  assembly: AssemblyDocument, library: PartLibrary, partRef: string,
): { readonly count: number; readonly complete: boolean } {
  type Count = { readonly count: number; readonly complete: boolean };
  const memo = new Map<string, Count>();
  const visit = (document: AssemblyDocument, ancestors: ReadonlySet<string>, depth: number): Count => {
    let count = 0;
    let complete = true;
    const add = (value: number): void => {
      if (value > Number.MAX_SAFE_INTEGER - count) {
        count = Number.MAX_SAFE_INTEGER;
        complete = false;
      } else count += value;
    };
    for (const component of document.components) {
      if (component.source.kind === 'part') {
        if (component.source.partRef === partRef) add(1);
      } else if (component.source.kind === 'subAssembly') {
        const ref = component.source.assemblyRef;
        const nested = library.assemblies?.get(ref);
        if (nested === undefined || ancestors.has(ref) || depth + 1 > MAX_SUB_ASSEMBLY_DEPTH) {
          complete = false;
          continue;
        }
        const nextAncestors = new Set([...ancestors, ref]);
        const key = JSON.stringify([ref, depth + 1, [...nextAncestors].sort()]);
        let result = memo.get(key);
        if (result === undefined) {
          result = visit(nested, nextAncestors, depth + 1);
          memo.set(key, result);
        }
        add(result.count);
        complete = complete && result.complete;
      }
    }
    return { count, complete };
  };
  return visit(assembly, new Set(), 0);
}

/** A tagged UUID identifies lineage; it does not authenticate file contents. */
export function hasPartLineageId(document: PartDocument): boolean {
  return /^part-uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(document.id);
}

export interface RefreshPartDeps {
  readonly choose: ReplaceComponentDeps['choose'];
  readonly read: ReplaceComponentDeps['read'];
  readonly replace: (
    library: PartLibrary, partRef: string, document: PartDocument,
    attachments: EmbeddedPartAttachments,
  ) => Promise<PartLibrary>;
}

const REFRESH_PART_DEPS: RefreshPartDeps = {
  choose: REPLACEMENT_DEPS.choose,
  read: REPLACEMENT_DEPS.read,
  replace: (library, partRef, document, attachments) =>
    replacePartDocument(library, partRef, document, { attachments }),
};

/** Updates the shared source; never rematches or rewrites saved mate targets. */
export function refreshPartReadiness(
  state: ReturnType<typeof useAppStore.getState>, componentId: string,
): { readonly ready: boolean; readonly reasonKey: 'assembly.refresh.busy' | 'assembly.refresh.partOnly' | null } {
  if (activeAssemblyDocument(state) === null) return { ready: false, reasonKey: 'assembly.refresh.partOnly' };
  if (state.assemblyReplacementBusy || state.assemblyReplacementPreview !== null
    || state.assemblyPlacement !== null || state.assemblyMateDraft !== null
    || state.assemblyDrag !== null || state.isComputing) {
    return { ready: false, reasonKey: 'assembly.refresh.busy' };
  }
  const component = state.assembly === null ? undefined : findComponent(state.assembly, componentId);
  const source = component?.source;
  if (source?.kind !== 'part'
    || !state.assemblyLibrary.parts.has(source.partRef)
    || !state.assemblyLibrary.partFiles.some(file => file.ref === source.partRef)) {
    return { ready: false, reasonKey: 'assembly.refresh.partOnly' };
  }
  return { ready: true, reasonKey: null };
}

export async function startRefreshPartSource(
  componentId: string, deps: RefreshPartDeps = REFRESH_PART_DEPS,
): Promise<void> {
  const before = useAppStore.getState();
  if (!refreshPartReadiness(before, componentId).ready || before.assembly === null) return;
  const assembly = before.assembly;
  const component = findComponent(assembly, componentId);
  if (component?.source.kind !== 'part') return;
  const partRef = component.source.partRef;
  const library = before.assemblyLibrary;
  const source = library.parts.get(partRef);
  const provenance = library.partFiles.find(file => file.ref === partRef);
  if (source === undefined || provenance === undefined) return;
  const documentId = before.activeDocumentId;
  const requestId = crypto.randomUUID();
  const ownsRequest = (): boolean => {
    if (!currentRequest(requestId, documentId, assembly, library)) return false;
    if (activeAssemblyDocument(useAppStore.getState()) !== assembly) return false;
    const current = findComponent(assembly, componentId);
    return current === component && current.source.kind === 'part'
      && current.source.partRef === partRef && library.parts.get(partRef) === source;
  };
  useAppStore.setState({ assemblyReplacementBusy: true, assemblyReplacementRequestId: requestId });
  try {
    const picked = await deps.choose(before.fileGateway);
    if (!ownsRequest() || picked === null || picked.kind !== 'pcad') return;
    const read = await deps.read(picked.bytes);
    if (!ownsRequest()) return;
    if (!read.ok || read.bundle.kind !== 'part') {
      useAppStore.getState().setFileMessage({
        key: read.ok ? 'file.openFailed' : openErrorMessageKey(read.error.code), failed: true,
      });
      return;
    }
    if (read.bundle.document.id !== source.id) {
      useAppStore.getState().setFileMessage({ key: 'assembly.refresh.foreignDocument', failed: true });
      return;
    }
    const next = await deps.replace(library, partRef, read.bundle.document, read.bundle.attachments);
    if (!ownsRequest()) return;
    const updated = next.partFiles.find(file => file.ref === partRef);
    if (updated === undefined || next.parts.get(partRef)?.id !== source.id) return;
    if (updated.contentHash === provenance.contentHash
      && updated.attachmentsDigest === provenance.attachmentsDigest) return;
    if (!hasPartLineageId(source)) {
      const occurrences = sharedPartOccurrenceCount(assembly, library, partRef);
      const approved = await useAppStore.getState().requestPartSourceConfirm({
        requestId, sourceName: source.name, fileName: picked.fileName,
        occurrenceCount: occurrences.count, countComplete: occurrences.complete,
        isCurrent: ownsRequest,
      });
      if (!approved || !ownsRequest()) return;
    }
    useAppStore.getState().applyAssembly(assembly, next);
  } catch {
    if (ownsRequest()) useAppStore.getState().setFileMessage({ key: 'file.openFailed', failed: true });
  } finally {
    useAppStore.getState().answerPartSourceConfirm(requestId, false);
    finishRequest(requestId);
  }
}
