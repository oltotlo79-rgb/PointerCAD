import { evaluateExpression } from '@pointercad/expression';
import {
  createStandardPartSource, createSteelBend, emptyEmbeddedPartAttachments, findComponent,
  planSteelBend, replacePartDocument, steelBendSection, steelProductFromSource, steelProductOptions,
  type PartDocument, type StandardPartSource, type SteelBendDimensions, type SteelBendResult, type SteelProduct,
} from '@pointercad/model';

import { steelBendInputState } from '../../../model/src/assembly/standard/steelBend.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginDocumentRequest } from '../store/documentRequest.js';

export interface SteelBendSources {
  readonly directionDegrees?: string;
  readonly radius: string;
  readonly angleDegrees: string;
  readonly firstLeg: string;
  readonly secondLeg: string;
  readonly radiusConvention: SteelBendDimensions['radiusConvention'];
  readonly legDimension: SteelBendDimensions['legDimension'];
}
export const DEFAULT_STEEL_BEND_SOURCES: SteelBendSources = {
  radius: '100', angleDegrees: '90', directionDegrees: '0', firstLeg: '200', secondLeg: '200',
  radiusConvention: 'inside', legDimension: 'tangent',
};
export type SteelBendPickerResult = SteelBendResult | { readonly ok: false; readonly reason: 'invalidExpression' };

/** Creates a new sourced stock item; it never relabels an existing purchased part. */
export function buildSteelBendChoice(product: SteelProduct, sources: SteelBendSources): SteelBendPickerResult {
  return buildFromSources(product, sources);
}

function buildFromSources(product: SteelProduct, sources: SteelBendSources,
  stockSource?: StandardPartSource): SteelBendPickerResult {
  const radius = evaluateExpression(sources.radius);
  const angle = evaluateExpression(sources.angleDegrees);
  const direction = evaluateExpression(sources.directionDegrees ?? '0');
  const first = evaluateExpression(sources.firstLeg);
  const second = evaluateExpression(sources.secondLeg);
  if (!radius.ok || !angle.ok || !direction.ok || !first.ok || !second.ok) return { ok: false, reason: 'invalidExpression' };
  const dimensions: SteelBendDimensions = { radius: radius.value.value, angleDegrees: angle.value.value,
    ...(sources.directionDegrees === undefined ? {} : { directionDegrees: direction.value.value }),
    firstLeg: first.value.value, secondLeg: second.value.value,
    radiusConvention: sources.radiusConvention, legDimension: sources.legDimension, sources };
  const section = steelBendSection(product);
  if (section === null) return { ok: false, reason: 'invalidSection' };
  const plan = planSteelBend(section, dimensions);
  if (!plan.ok) return plan;
  const source = stockSource === undefined ? createStandardPartSource(product.catalog, product.size, {
    ...steelProductOptions(product), length: String(plan.geometry.centrelineLengthMm),
  }) : { ...stockSource, options: { ...stockSource.options, length: String(plan.geometry.centrelineLengthMm) } };
  return createSteelBend(source, dimensions);
}

export type SteelBendEditFailure = 'missing' | 'modified' | 'unsupported' | 'unavailable' | 'failed';
export type SteelBendEditResult = SteelBendPickerResult | { readonly ok: false; readonly reason: SteelBendEditFailure };
export type SteelBendEditInput =
  | { readonly ok: true; readonly sources: SteelBendSources; readonly product: SteelProduct }
  | { readonly ok: false; readonly reason: 'missing' | 'modified' | 'unsupported' };

/** W03 is the authority: never infer an authored recipe from a sketch or today's defaults. */
export function readSteelBendEditInput(document: PartDocument): SteelBendEditInput {
  const saved = steelBendInputState(document);
  if (saved.status !== 'original') return { ok: false, reason: saved.status };
  const product = steelProductFromSource(saved.input.stockSource);
  if (product === undefined) return { ok: false, reason: 'unsupported' };
  const input = saved.input;
  return { ok: true, product, sources: { radiusConvention: input.radiusConvention, legDimension: input.legDimension,
    radius: input.radius.source, angleDegrees: input.angleDegrees.source,
    firstLeg: input.firstLeg.source, secondLeg: input.secondLeg.source,
    ...(input.directionDegrees === undefined ? {} : { directionDegrees: input.directionDegrees.source }) } };
}

/** Regenerate only the proved original history; keep the part's identity, appearance and other metadata. */
export function buildSteelBendEdit(document: PartDocument, sources: SteelBendSources): SteelBendEditResult {
  const saved = readSteelBendEditInput(document);
  if (!saved.ok) return saved;
  const result = buildFromSources(saved.product, sources, document.steelStockSource);
  if (!result.ok) return result;
  return { ...result, document: { ...document, sketches: result.document.sketches,
    references: result.document.references, solids: result.document.solids,
    steelStockSource: result.document.steelStockSource } };
}

type AppSnapshot = ReturnType<typeof useAppStore.getState>;
export interface SteelBendEditTarget {
  readonly documentId: string;
  readonly version: number;
  readonly assembly: NonNullable<AppSnapshot['assembly']>;
  readonly library: AppSnapshot['assemblyLibrary'];
  readonly history: AppSnapshot['assemblyUndoStack'];
  readonly componentId: string;
  readonly partRef: string;
  readonly document: PartDocument;
}

/** Selecting an old bend still exposes the entry, so a missing recipe gets an explanation. */
export function selectedSteelBendEditTarget(state: AppSnapshot): SteelBendEditTarget | null {
  if (state.assembly === null || state.selection.length !== 1) return null;
  const component = findComponent(state.assembly, state.selection[0]);
  if (component?.source.kind !== 'part') return null;
  const document = state.assemblyLibrary.parts.get(component.source.partRef);
  if (document === undefined || !document.solids.some(feature => feature.kind === 'sweep'
    && (feature.steelBend !== undefined || feature.id.startsWith('steel-bend-sweep-')))) return null;
  return { documentId: state.activeDocumentId, version: state.documentVersion,
    assembly: state.assembly, library: state.assemblyLibrary, history: state.assemblyUndoStack,
    componentId: component.id, partRef: component.source.partRef, document };
}

function currentEditTarget(state: AppSnapshot, target: SteelBendEditTarget): boolean {
  return state.standardPartPickerOpen && state.activeDocumentId === target.documentId
    && state.documentVersion === target.version && state.assembly === target.assembly
    && state.assemblyLibrary === target.library && state.assemblyUndoStack === target.history
    && state.selection.length === 1 && state.selection[0] === target.componentId
    && !state.isComputing && state.assemblyPlacement === null && state.assemblyMateDraft === null
    && state.assemblyDrag === null;
}

/** Use the ordinary library replacement and a single assembly snapshot, including provenance and attachments. */
export async function commitSteelBendEdit(target: SteelBendEditTarget, sources: SteelBendSources,
  signal?: AbortSignal): Promise<SteelBendEditResult> {
  const before = useAppStore.getState();
  if (!currentEditTarget(before, target) || before.assemblyReplacementBusy || signal?.aborted) {
    return { ok: false, reason: 'unavailable' };
  }
  const result = buildSteelBendEdit(target.document, sources);
  if (!result.ok) return result;
  const request = beginDocumentRequest('assembly.steelBendEdit', before);
  const requestId = crypto.randomUUID();
  useAppStore.setState({ assemblyReplacementBusy: true, assemblyReplacementRequestId: requestId });
  let stale = false;
  const current = (): boolean => {
    const state = useAppStore.getState();
    return !stale && !signal?.aborted && request.isCurrent() && currentEditTarget(state, target)
      && state.assemblyReplacementRequestId === requestId;
  };
  // Once closed/changed, reopening or undoing cannot revive this pending commit.
  const unsubscribe = useAppStore.subscribe(() => { if (!current()) stale = true; });
  try {
    const library = await replacePartDocument(target.library, target.partRef, result.document);
    if (!current()) return { ok: false, reason: 'unavailable' };
    useAppStore.getState().applyAssembly(target.assembly, library);
    return result;
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    unsubscribe();
    if (useAppStore.getState().assemblyReplacementRequestId === requestId) {
      useAppStore.setState({ assemblyReplacementBusy: false, assemblyReplacementRequestId: null });
    }
  }
}

/** Hand the whole editable part to the existing cancellable, one-Undo library placement. */
export function beginSteelBendPlacement(result: Extract<SteelBendPickerResult, { readonly ok: true }>): boolean {
  const state = useAppStore.getState();
  if (!state.standardPartPickerOpen || state.assembly === null || state.isComputing
    || state.assemblyPlacement !== null || state.assemblyMateDraft !== null || state.assemblyDrag !== null) return false;
  useAppStore.setState({ standardPartPickerOpen: false, assemblyPlacement: {
    kind: 'ready', requestId: crypto.randomUUID(), documentId: state.activeDocumentId,
    fileName: `${result.document.name}.pcad`, document: result.document,
    attachments: emptyEmbeddedPartAttachments(), sources: ['0', '0', '0'],
  } });
  return true;
}
