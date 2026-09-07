import { readDocumentBundle, type ReadDocumentBundleResult } from '@pointercad/io';
import {
  embedPart,
  findComponent,
  setComponentSuppressed,
  setFixed,
  setVisible,
  type EmbedPartResult,
  type EmbeddedPartAttachments,
  type PartDocument,
  type PartLibrary,
} from '@pointercad/model';
import { openFileThrough, type FileGateway, type PickedTypedFile } from '../file/fileGateway.js';
import { openErrorMessageKey } from '../file/partFile.js';
import type { AssemblyPlacementState } from '../store/assemblySlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { duplicateComponent as duplicateComponentDocument, placePart, placementFromSources, removeComponents,
  type PlacementInputOutcome } from './placeComponent.js';

export interface PlaceComponentDeps {
  readonly choose: (gateway: FileGateway) => Promise<PickedTypedFile | null>;
  readonly read: (bytes: Uint8Array) => Promise<ReadDocumentBundleResult>;
  readonly embed: (
    library: PartLibrary,
    document: PartDocument,
    fileName: string,
    path: string,
    options: { readonly attachments: EmbeddedPartAttachments },
  ) => Promise<EmbedPartResult>;
}

const DEFAULT_DEPS: PlaceComponentDeps = {
  choose: (gateway) => openFileThrough(gateway, ['pcad']),
  read: (bytes) => readDocumentBundle(bytes, 'part'),
  embed: (library, document, fileName, path, options) =>
    embedPart(library, document, fileName, path, options),
};

function isCurrentPlacement(state: AssemblyPlacementState | null, requestId: string, documentId: string): boolean {
  return state?.requestId === requestId && state.documentId === documentId;
}

/** 選択と読込を始める。非同期の各境界で文書IDと要求IDを再確認する。 */
export async function startPlaceComponent(deps: PlaceComponentDeps = DEFAULT_DEPS): Promise<void> {
  const before = useAppStore.getState();
  if (before.assembly === null) return;
  const requestId = crypto.randomUUID();
  const documentId = before.activeDocumentId;
  useAppStore.setState({ assemblyPlacement: { kind: 'choosing', requestId, documentId } });
  let picked: PickedTypedFile | null;
  try {
    picked = await deps.choose(before.fileGateway);
  } catch {
    const current = useAppStore.getState();
    if (isCurrentPlacement(current.assemblyPlacement, requestId, documentId) &&
        current.activeDocumentId === documentId) {
      useAppStore.setState({ assemblyPlacement: null });
      current.setFileMessage({ key: 'file.openFailed', failed: true });
    }
    return;
  }
  let current = useAppStore.getState();
  if (!isCurrentPlacement(current.assemblyPlacement, requestId, documentId) ||
      current.activeDocumentId !== documentId) return;
  if (picked === null) {
    useAppStore.setState({ assemblyPlacement: null });
    return;
  }
  let result: ReadDocumentBundleResult;
  try {
    result = await deps.read(picked.bytes);
  } catch {
    current = useAppStore.getState();
    if (isCurrentPlacement(current.assemblyPlacement, requestId, documentId) &&
        current.activeDocumentId === documentId) {
      useAppStore.setState({ assemblyPlacement: null });
      current.setFileMessage({ key: 'file.openFailed', failed: true });
    }
    return;
  }
  current = useAppStore.getState();
  if (!isCurrentPlacement(current.assemblyPlacement, requestId, documentId) ||
      current.activeDocumentId !== documentId) return;
  if (!result.ok) {
    useAppStore.setState({ assemblyPlacement: null });
    current.setFileMessage({ key: openErrorMessageKey(result.error.code), failed: true });
    return;
  }
  if (result.bundle.kind !== 'part') {
    useAppStore.setState({ assemblyPlacement: null });
    current.setFileMessage({ key: 'file.openFailed', failed: true });
    return;
  }
  useAppStore.setState({
    assemblyPlacement: {
      kind: 'ready', requestId, documentId, fileName: picked.fileName,
      document: result.bundle.document, attachments: result.bundle.attachments,
      sources: ['', '', ''],
    },
  });
}

/** XYZ式の1欄を更新する。読込中・確定中・古い要求には書き込まない。 */
export function updatePlaceComponentSource(index: 0 | 1 | 2, source: string): void {
  const placement = useAppStore.getState().assemblyPlacement;
  if (placement === null || placement.kind !== 'ready') return;
  const sources: [string, string, string] = [...placement.sources];
  sources[index] = source;
  useAppStore.setState({ assemblyPlacement: { ...placement, sources } });
}

/** 配置欄を確定する。不正入力なら文書も履歴も変えず、欄の理由だけを返す。 */
export async function commitPlaceComponent(
  deps: PlaceComponentDeps = DEFAULT_DEPS,
): Promise<PlacementInputOutcome | null> {
  const before = useAppStore.getState();
  const pending = before.assemblyPlacement;
  if (before.assembly === null || pending === null || pending.kind !== 'ready') {
    return null;
  }
  const placement = placementFromSources(before.assembly, pending.sources);
  if (!placement.ok) return placement;
  const assembly = before.assembly;
  const library = before.assemblyLibrary;
  useAppStore.setState({ assemblyPlacement: { ...pending, kind: 'committing' } });
  try {
    const embedded = await deps.embed(
      library, pending.document, pending.fileName, '', { attachments: pending.attachments },
    );
    const current = useAppStore.getState();
    if (!isCurrentPlacement(current.assemblyPlacement, pending.requestId, pending.documentId) ||
        current.activeDocumentId !== pending.documentId || current.assembly !== assembly ||
        current.assemblyLibrary !== library) return placement;
    const placed = placePart(assembly, embedded.partRef, pending.document.name, placement.placement);
    current.applyAssembly(placed.document, embedded.library);
    current.setSelection([placed.component.id]);
  } catch {
    const current = useAppStore.getState();
    if (isCurrentPlacement(current.assemblyPlacement, pending.requestId, pending.documentId) &&
        current.activeDocumentId === pending.documentId) {
      useAppStore.setState({ assemblyPlacement: null });
      current.setFileMessage({ key: 'file.openFailed', failed: true });
    }
  }
  return placement;
}

export function cancelPlaceComponent(): void {
  useAppStore.setState({ assemblyPlacement: null });
}

function selectedComponentIds(): readonly string[] {
  const state = useAppStore.getState();
  const assembly = state.assembly;
  if (assembly === null) return [];
  return state.selection.filter((id) => findComponent(assembly, id) !== undefined);
}

export function duplicateSelectedComponent(): void {
  const id = selectedComponentIds()[0];
  if (id === undefined) return;
  duplicateAssemblyComponent(id);
}

/** 指定した部品を複製する。ツリーとツールバーの共通入口。 */
export function duplicateAssemblyComponent(componentId: string): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const result = duplicateComponentDocument(state.assembly, componentId);
  if (result.component === null) return;
  state.applyAssembly(result.document);
  state.setSelection([result.component.id]);
}

export function deleteSelectedComponents(): void {
  const ids = selectedComponentIds();
  if (ids.length === 0) return;
  deleteAssemblyComponents(ids);
}

/** 指定した部品をまとめて削除し、存在しなくなった選択・ホバーも同時に掃除する。 */
export function deleteAssemblyComponents(componentIds: readonly string[]): void {
  const state = useAppStore.getState();
  const assembly = state.assembly;
  if (assembly === null) return;
  const ids = componentIds.filter((id) => findComponent(assembly, id) !== undefined);
  if (ids.length === 0) return;
  const removed = new Set(ids);
  state.applyAssembly(removeComponents(assembly, ids));
  const after = useAppStore.getState();
  after.setSelection(after.selection.filter((id) => !removed.has(id)));
  if (after.hoveredElementId !== null && removed.has(after.hoveredElementId)) after.setHovered(null);
}

export function toggleSelectedFixed(): void {
  const id = selectedComponentIds()[0];
  if (id !== undefined) toggleAssemblyComponentFixed(id);
}

export function toggleAssemblyComponentFixed(componentId: string): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const component = findComponent(state.assembly, componentId);
  if (component === undefined) return;
  state.applyAssembly(setFixed(state.assembly, component.id, !component.fixed));
}

export function toggleSelectedVisible(): void {
  const id = selectedComponentIds()[0];
  if (id !== undefined) toggleAssemblyComponentVisible(id);
}

export function toggleAssemblyComponentVisible(componentId: string): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const component = findComponent(state.assembly, componentId);
  if (component === undefined) return;
  state.applyAssembly(setVisible(state.assembly, component.id, !component.visible));
}

export function toggleAssemblyComponentSuppressed(componentId: string): void {
  const state = useAppStore.getState();
  if (state.assembly === null) return;
  const component = findComponent(state.assembly, componentId);
  if (component === undefined) return;
  state.applyAssembly(setComponentSuppressed(state.assembly, component.id, !component.suppressed));
}
