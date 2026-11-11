import { writePcadFile } from '@pointercad/io';
import { buildStandardPartFromSource, emptyEmbeddedPartAttachments, type PartDocument,
  type SteelBendResult } from '@pointercad/model';

import { saveFileAsThrough, withPcadExtension } from '../file/fileGateway.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { createPartLineageId } from '../store/documentIdentity.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitStandardPartChoice } from './standardPartPicker.js';

export type EditableSteelPartFailure = 'unknownChoice' | 'invalidLength' | 'notSteelStock' | 'unavailable';
export type EditableSteelPartResult =
  | { readonly ok: true; readonly document: PartDocument; readonly fileName: string }
  | { readonly ok: false; readonly reason: EditableSteelPartFailure };
export type EditableSteelPlacementOutcome = 'placing' | 'busy' | 'cancelled' | 'failed' | EditableSteelPartFailure;

/**
 * A straight stock as an ordinary editable part: the same source the picker would place
 * (commitStandardPartChoice), the generator's own solids and steelStockSource, and a fresh lineage id
 * so 元の部品を取り込み直す recognises the edited file. Nothing is built when the generator cannot.
 */
export function buildEditableSteelPart(choiceKey: string, lengthSource: string,
  lineageId: () => string = createPartLineageId): EditableSteelPartResult {
  const committed = commitStandardPartChoice('structuralSection', choiceKey, lengthSource);
  if (!committed.ok) return { ok: false, reason: committed.reason };
  const document = buildStandardPartFromSource(committed.value.source);
  // Legacy rows without a material grade have no steel provenance; they stay standard parts only.
  if (document !== null && document.steelStockSource === undefined) return { ok: false, reason: 'notSteelStock' };
  if (document === null || document.solids.length === 0) return { ok: false, reason: 'unavailable' };
  // A length expression such as 1000/2 is kept in the part name but never becomes a path separator.
  const fileName = editableFileName(document);
  return { ok: true, document: { ...document, id: lineageId() }, fileName };
}

function placementBusy(state: ReturnType<typeof useAppStore.getState>): boolean {
  return !state.standardPartPickerOpen || state.assembly === null || state.isComputing
    || state.assemblyPlacement !== null || state.assemblyMateDraft !== null || state.assemblyDrag !== null
    || activeDocumentKind(state) !== 'assembly';
}

/**
 * Saves the new part file first (it is the file the user opens, machines and saves), then hands the same
 * document to the existing placement: position fields, one Undo step and the library entry are the
 * ordinary 部品を置く ones. A cancelled, failed or superseded save places nothing.
 */
export async function placeEditableSteelPart(choiceKey: string, lengthSource: string,
  lineageId: () => string = createPartLineageId): Promise<EditableSteelPlacementOutcome> {
  if (placementBusy(useAppStore.getState())) return 'busy';
  let built: EditableSteelPartResult;
  try { built = buildEditableSteelPart(choiceKey, lengthSource, lineageId); }
  catch { return 'failed'; } // No secure entropy for the lineage id: never fall back to a shared id.
  if (!built.ok) return built.reason;
  return saveThenPlace(built);
}

/** A picker bend as the same kind of editable part file: saved first (fresh lineage id), so 開く→切断→保存→
 * 元の部品を取り込み直す can reach it. The bend geometry and its steelStockSource are the generator's own. */
export async function placeEditableSteelBend(bend: Extract<SteelBendResult, { readonly ok: true }>,
  lineageId: () => string = createPartLineageId,
): Promise<Exclude<EditableSteelPlacementOutcome, 'invalidLength' | 'unknownChoice' | 'unavailable'>> {
  if (placementBusy(useAppStore.getState())) return 'busy';
  if (bend.document.steelStockSource === undefined) return 'notSteelStock';
  let id: string;
  try { id = lineageId(); }
  catch { return 'failed'; } // No secure entropy for the lineage id: never fall back to a shared id.
  return saveThenPlace({ ok: true, document: { ...bend.document, id }, fileName: editableFileName(bend.document) });
}

function editableFileName(document: PartDocument): string {
  return withPcadExtension(document.name.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_'));
}

async function saveThenPlace(built: Extract<EditableSteelPartResult, { readonly ok: true }>,
): Promise<'placing' | 'busy' | 'cancelled' | 'failed'> {
  const before = useAppStore.getState();
  if (placementBusy(before)) return 'busy';
  const requestId = crypto.randomUUID();
  const documentId = before.activeDocumentId;
  const assembly = before.assembly;
  const controller = new AbortController();
  const current = (): boolean => {
    const state = useAppStore.getState();
    return !controller.signal.aborted && state.assemblyPlacement?.kind === 'choosing'
      && state.assemblyPlacement.requestId === requestId && state.activeDocumentId === documentId
      && state.assembly === assembly;
  };
  useAppStore.setState({ assemblyPlacement: { kind: 'choosing', requestId, documentId } });
  const unsubscribe = useAppStore.subscribe(() => { if (!current()) controller.abort(); });
  let saved: boolean;
  try {
    saved = await saveFileAsThrough(before.fileGateway, built.fileName, 'pcad',
      writePcadFile(built.document), { signal: controller.signal, isCurrent: current });
  } catch {
    unsubscribe();
    if (current()) useAppStore.setState({ assemblyPlacement: null });
    return 'failed';
  }
  unsubscribe();
  if (!current()) return 'cancelled';
  if (!saved) {
    useAppStore.setState({ assemblyPlacement: null });
    return 'cancelled';
  }
  useAppStore.setState({ standardPartPickerOpen: false, assemblyPlacement: {
    kind: 'ready', requestId, documentId, fileName: built.fileName, document: built.document,
    attachments: emptyEmbeddedPartAttachments(), sources: ['0', '0', '0'],
  } });
  return 'placing';
}
