import { canPersistAssemblyPartEdit, canPersistPartAttachments } from '@pointercad/io';
import {
  createAssemblyDocumentBundle, createEmptyPartDocument, createUndoStack, DEFAULT_WORK_PLANE_ID, findComponent, replacePartDocument, resolveSketch,
  pruneContextPlaneLinks, withContextPlaneLink,
  type ContextReferenceLink, type EmbeddedPartAttachments, type EmbeddedPartFile, type PartDocument, type UndoStack,
} from '@pointercad/model';
import type { StoreApi } from 'zustand';
import { sharedPartOccurrenceCount } from '../assembly/partOccurrenceCount.js';
import type { AppState } from './appState.js';
import type { AssemblySnapshot } from './assemblySlice.js';
import { activeSketchOf, documentEditPatch, documentPatch, documentWithIssuanceLedger, prepareDocumentEdit, rememberTimelineHintShown,
  type DocumentEditPlacement } from './documentDerived.js';
import { freshPartInteraction } from './documentSlice.js';
import { captureDocumentIdentity, compareDocumentIdentity, type DocumentIdentity } from './documentRequestCore.js';

/** The parent and embedded entry observed before an editing operation starts. */
interface AssemblyPartEditTarget extends AssemblySnapshot {
  readonly identity: DocumentIdentity;
  readonly numericInputRevision: number;
  readonly cancelRequestCount: number;
  readonly workPlaneId: AppState['workPlaneId'];
  readonly timelineIndex: AppState['timelineIndex'];
  readonly selection: AppState['selection'];
  readonly constraintPrompt: AppState['constraintPrompt'];
  readonly constraintTargets: AppState['constraintTargets'];
  readonly componentId: string;
  readonly part: PartDocument;
  readonly file: EmbeddedPartFile;
  readonly attachments: EmbeddedPartAttachments;
  readonly session: symbol | undefined;
}

type AssemblyPartEditCapture =
  | { readonly ok: true; readonly target: AssemblyPartEditTarget }
  | { readonly ok: false; readonly reason: 'targetUnavailable' | 'targetPartShared' | 'targetCountUnknown' };

type AssemblyPartEditCommit = 'applied' | 'unchanged' | 'stale' | 'failed';

export interface AssemblyPartEditActions {
  readonly captureEditableAssemblyPart: (componentId: string) => AssemblyPartEditCapture;
  readonly commitEditedAssemblyPart: (target: AssemblyPartEditTarget, part: PartDocument,
    attachments?: EmbeddedPartAttachments, adopt?: AssemblyPartAdoption) => Promise<AssemblyPartEditCommit>;
  readonly beginAssemblyPartEdit: (componentId: string) => boolean;
  readonly endAssemblyPartEdit: () => void;
  readonly setPartEditContextPick: (kind: PartEditContextPickKind | null) => void;
  readonly commitAssemblyPartPlacement: (placement: DocumentEditPlacement, adopt?: AssemblyPartAdoption) => Promise<AssemblyPartEditCommit>;
}

export interface AssemblyPartAdoption {
  readonly contextPlaneLink?: ContextReferenceLink;
  readonly isCurrent?: (state: AppState) => boolean;
  readonly patch?: (state: AppState, fields: Partial<AppState>) => Partial<AppState>;
  readonly onApplied?: (state: AppState) => void;
}

type RetainedPart = Pick<AppState, 'document' | 'undoStack' | 'importedShapes' | 'importedMeshes' | 'canvases'
  | 'canvasPixelSizes' | 'canvasImageLoads' | 'canvasImageRetries' | 'timelineIndex' | 'workPlaneId'>;
type AssemblyCalculation = Pick<AppState, 'requestedGeneration' | 'completedGeneration' | 'lastOutcome' | 'isComputing'
  | 'cancelRequestCount' | 'recomputeCancelled' | 'recomputeProgress' | 'errorMessage' | 'cacheHits' | 'timelineIndex'>;

export type PartEditContextPickKind = 'plane' | 'holeCenters' | 'outline';
interface PartEditContextPick { readonly kind: PartEditContextPickKind }

export interface AssemblyPartEdit {
  readonly id: symbol;
  readonly componentId: string;
  readonly partRef: string;
  readonly contextPick: PartEditContextPick | null;
  readonly retained: RetainedPart;
  readonly parentCalculation: AssemblyCalculation;
  readonly backgroundLibrary: AssemblySnapshot['library'];
}

function retainedPartOf(state: AppState): RetainedPart {
  return { document: state.document, undoStack: state.undoStack,
    importedShapes: state.importedShapes, importedMeshes: state.importedMeshes, canvases: state.canvases,
    canvasPixelSizes: state.canvasPixelSizes, canvasImageLoads: state.canvasImageLoads,
    canvasImageRetries: state.canvasImageRetries, timelineIndex: state.timelineIndex, workPlaneId: state.workPlaneId };
}

/** 子の作図・立体を計算中も、親の採用判定は親の依頼と結果を読む。 */
export function assemblyCalculation(state: AppState): AssemblyCalculation {
  return state.partEdit?.parentCalculation ?? state;
}

/** The solved context stays in its original frame while only the edited definition changes. */
export function assemblyBackgroundLibrary(state: AppState): AssemblySnapshot['library'] {
  return state.partEdit?.backgroundLibrary ?? state.assemblyLibrary;
}

export function assemblyCalculationPatch(state: AppState, fields: Partial<AssemblyCalculation>): Partial<AppState> {
  return state.partEdit === null ? fields
    : { partEdit: { ...state.partEdit, parentCalculation: { ...state.partEdit.parentCalculation, ...fields } } };
}

function calculationOf(state: AppState): AssemblyCalculation {
  const { requestedGeneration, completedGeneration, lastOutcome, isComputing, cancelRequestCount,
    recomputeCancelled, recomputeProgress, errorMessage, cacheHits, timelineIndex } = state;
  return { requestedGeneration, completedGeneration, lastOutcome, isComputing, cancelRequestCount,
    recomputeCancelled, recomputeProgress, errorMessage, cacheHits, timelineIndex };
}

const emptyResolvedSketch = resolveSketch(activeSketchOf(createEmptyPartDocument()));

function clearPartResults(): Partial<AppState> {
  return { bodies: [], resolvedPartSketches: null, referenceRepairBodies: null, meshJsAccounting: null,
    stagedSolid: null, recomputeProgress: null, sketchMesh: null, resolvedSketch: emptyResolvedSketch };
}

export function finishAssemblyPartEdit(state: AppState): Partial<AppState> {
  const edit = state.partEdit;
  if (edit === null) return {};
  const retained = edit.retained;
  return { ...documentPatch({ ...state, ...retained }, retained.document, retained.undoStack, true),
    ...retained, ...freshPartInteraction(), ...clearPartResults(), ...edit.parentCalculation,
    partEdit: null, canUndo: state.canUndo, canRedo: state.canRedo };
}

function attachWorkingPart(state: AppState, target: AssemblyPartEditTarget, fresh: boolean): Partial<AppState> {
  const document = target.part, attachments = target.attachments;
  const fields = { importedShapes: attachments.shapes, importedMeshes: attachments.meshes, canvases: attachments.canvases };
  const source = { ...state, ...(fresh ? {
    ...freshPartInteraction(), workPlaneId: DEFAULT_WORK_PLANE_ID,
    canvasPixelSizes: new Map(), canvasImageLoads: new Map(), canvasImageRetries: new Map(),
  } : {}), ...fields };
  const placement = { document, timelineIndex: null, inserted: false };
  const patch = documentEditPatch(source, placement, createUndoStack(document), fresh, undefined);
  return { ...patch, ...fields, documentVersion: state.documentVersion,
    ...(fresh ? { ...freshPartInteraction(), ...clearPartResults(), isComputing: true } : {}) };
}

/** Update the working part in the same publication as the parent's saved snapshot and history. */
export function syncAssemblyPartEdit(state: AppState, stack: UndoStack<AssemblySnapshot>, fromHistory: boolean): Partial<AppState> {
  const edit = state.partEdit;
  if (edit === null) return {};
  const previous = state.assemblyLibrary.parts.get(edit.partRef);
  const next = capture({ ...state, assembly: stack.present.document, assemblyLibrary: stack.present.library,
    assemblyUndoStack: stack }, edit.componentId);
  if (!next.ok || next.target.file.ref !== edit.partRef) {
    return finishAssemblyPartEdit(state);
  }
  const { document, library } = stack.present;
  const keepBackground = !fromHistory && state.assembly === document && sameOtherParts(edit.backgroundLibrary, library, edit.partRef);
  const partEdit = keepBackground ? edit : { ...edit, backgroundLibrary: library, contextPick: null };
  if (!fromHistory && next.target.part === previous && next.target.attachments === state.assemblyLibrary.attachments.get(edit.partRef)) {
    return partEdit === edit ? {} : { partEdit };
  }
  return { ...attachWorkingPart(state, next.target, fromHistory), partEdit };
}

function sameOtherEntries<T>(left: ReadonlyMap<string, T>, right: ReadonlyMap<string, T>, editRef: string): boolean {
  if (left.size !== right.size) return false;
  for (const [ref, value] of left) if (ref !== editRef && right.get(ref) !== value) return false;
  return true;
}

function sameOtherParts(left: AssemblySnapshot['library'], right: AssemblySnapshot['library'], editRef: string): boolean {
  return left.assemblies === right.assemblies && sameOtherEntries(left.parts, right.parts, editRef)
    && sameOtherEntries(left.attachments, right.attachments, editRef);
}

function capture(state: AppState, componentId: string): AssemblyPartEditCapture {
  const { assembly, assemblyLibrary: library, assemblyUndoStack: history } = state;
  if (assembly === null || history === null || history.present.document !== assembly || history.present.library !== library) {
    return { ok: false, reason: 'targetUnavailable' };
  }
  const component = findComponent(assembly, componentId);
  if (component === undefined || component.suppressed || component.source.kind !== 'part') {
    return { ok: false, reason: 'targetUnavailable' };
  }
  const { partRef } = component.source;
  const part = library.parts.get(partRef), attachments = library.attachments.get(partRef);
  const file = library.partFiles.find(entry => entry.ref === partRef);
  if (part === undefined || attachments === undefined || file === undefined) {
    return { ok: false, reason: 'targetUnavailable' };
  }
  const occurrences = sharedPartOccurrenceCount(assembly, library, partRef);
  if (!occurrences.complete) return { ok: false, reason: 'targetCountUnknown' };
  if (occurrences.count !== 1) return { ok: false, reason: 'targetPartShared' };
  return {
    ok: true,
    target: { document: assembly, library, componentId, part, file, attachments,
      identity: captureDocumentIdentity(state), selection: state.selection,
      numericInputRevision: state.numericInputRevision, cancelRequestCount: state.cancelRequestCount,
      constraintPrompt: state.constraintPrompt, constraintTargets: state.constraintTargets,
      workPlaneId: state.workPlaneId, timelineIndex: state.timelineIndex, session: state.partEdit?.id },
  };
}

function ownsTarget(state: AppState, target: AssemblyPartEditTarget): boolean {
  return compareDocumentIdentity(target.identity, state) === 'current' && state.selection === target.selection
    && state.partEdit?.id === target.session && (state.partEdit === null || state.partEdit.componentId === target.componentId)
    && state.numericInputRevision === target.numericInputRevision
    && state.cancelRequestCount === target.cancelRequestCount
    && state.constraintPrompt === target.constraintPrompt && state.constraintTargets === target.constraintTargets
    && state.workPlaneId === target.workPlaneId && state.timelineIndex === target.timelineIndex;
}

/** Run the successful interaction changes in the same turn that adopts the working document. */
export function commitWorkingPartDocument(
  state: AppState, document: PartDocument, onApplied: (state: AppState) => void,
  isCurrent?: (state: AppState) => boolean,
): boolean | Promise<boolean> {
  if (state.partEdit === null) {
    state.applyDocument(document);
    onApplied(state);
    return true;
  }
  return state.commitAssemblyPartPlacement(prepareDocumentEdit(state, document, false), {
    onApplied, ...(isCurrent === undefined ? {} : { isCurrent }),
  })
    .then(outcome => outcome === 'applied');
}

/** Commit an edited definition into the current assembly history and keep its saved part reference. */
export function createAssemblyPartEditActions(set: StoreApi<AppState>['setState'], get: () => AppState): AssemblyPartEditActions {
  let pending: { readonly session: symbol; readonly document: PartDocument; readonly result: Promise<AssemblyPartEditCommit>;
    readonly isCurrent: (state: AppState) => boolean } | null = null;
  return {
    captureEditableAssemblyPart: componentId => capture(get(), componentId),
    beginAssemblyPartEdit: componentId => {
      const state = get();
      const target = capture(state, componentId);
      if (state.partEdit !== null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null
        || state.assemblyDrag !== null || state.assemblyMotionPlaying || state.assemblyReplacementBusy
        || !target.ok || !canPersistPartAttachments(target.target.part, target.target.attachments, target.target.file.ref)) return false;
      set({ ...attachWorkingPart(state, target.target, true), canUndo: state.canUndo, canRedo: state.canRedo,
        partEdit: { id: Symbol(), componentId, partRef: target.target.file.ref, contextPick: null,
          retained: retainedPartOf(state), parentCalculation: calculationOf(state), backgroundLibrary: state.assemblyLibrary } });
      return true;
    },
    endAssemblyPartEdit: () => {
      const state = get();
      if (state.partEdit === null) return;
      const { componentId } = state.partEdit;
      set({ ...finishAssemblyPartEdit(state), selection: state.assembly?.components.some(component => component.id === componentId) ? [componentId] : [] });
    },
    setPartEditContextPick: kind => {
      const state = get(), edit = state.partEdit;
      if (edit === null || (edit.contextPick?.kind ?? null) === kind) return;
      if (kind !== null) state.setActiveTool('select');
      set(current => current.partEdit?.id === edit.id
        ? { partEdit: { ...current.partEdit, contextPick: kind === null ? null : { kind } } } : {});
      if (kind !== null) {
        state.setFileMessage({ key: kind === 'plane' ? 'assembly.partEdit.planeCopyPrompt' : 'assembly.partEdit.projectionPrompt', failed: false });
      } else if (state.fileMessage?.key === 'assembly.partEdit.planeCopyPrompt' || state.fileMessage?.key === 'assembly.partEdit.planeCopyUnavailable'
        || state.fileMessage?.key === 'assembly.partEdit.projectionPrompt' || state.fileMessage?.key === 'assembly.partEdit.projectionUnavailable') {
        state.setFileMessage(null);
      }
    },
    commitAssemblyPartPlacement: (placement, adopt) => {
      const state = get(), edit = state.partEdit;
      if (edit === null || placement.timelineIndex !== null) return Promise.resolve('stale');
      if (pending?.session === edit.id && pending.isCurrent(state)) {
        return pending.document === placement.document ? pending.result : Promise.resolve('stale');
      }
      const captured = capture(state, edit.componentId);
      if (!captured.ok || captured.target.file.ref !== edit.partRef) return Promise.resolve('stale');
      const next = documentWithIssuanceLedger(state, placement.document, false);
      const result = state.commitEditedAssemblyPart(captured.target, next, {
        shapes: state.importedShapes, meshes: state.importedMeshes, canvases: state.canvases,
      }, adopt).then(outcome => {
        const current = get();
        if (outcome === 'applied' && current.activeDocumentId === state.activeDocumentId && current.partEdit?.id === edit.id) {
          rememberTimelineHintShown(current);
        }
        if (outcome === 'failed' && ownsTarget(current, captured.target) && adopt?.isCurrent?.(current) !== false) {
          current.setFileMessage({ key: 'assembly.partEdit.commitFailed', failed: true });
        }
        return outcome;
      }).finally(() => {
        if (pending?.result === result) pending = null;
      });
      pending = { session: edit.id, document: placement.document, result,
        isCurrent: current => ownsTarget(current, captured.target) && adopt?.isCurrent?.(current) !== false };
      return result;
    },
    commitEditedAssemblyPart: async (target, part, attachments = target.attachments, adopt) => {
      const before = get();
      const isCurrent = (state: AppState): boolean => ownsTarget(state, target) && adopt?.isCurrent?.(state) !== false;
      if (!isCurrent(before) || part.id !== target.part.id) return 'stale';
      if (part === target.part && attachments === target.attachments) return 'unchanged';
      if (!canPersistPartAttachments(part, attachments, target.file.ref)) return 'failed';
      let updated: AssemblySnapshot['library'];
      let parent = target.document;
      try {
        updated = await replacePartDocument(target.library, target.file.ref, part, {
          attachments, importedAt: target.file.importedAt,
        });
        if (!isCurrent(get())) return 'stale';
        const file = updated.partFiles.find(entry => entry.ref === target.file.ref);
        if (file === undefined || updated === target.library) return 'stale';
        if (file.contentHash === target.file.contentHash && file.attachmentsDigest === target.file.attachmentsDigest) {
          return 'unchanged';
        }
        if (adopt?.contextPlaneLink !== undefined) {
          const linked = withContextPlaneLink(parent, updated, adopt.contextPlaneLink);
          if ('code' in linked) {
            return 'failed';
          }
          parent = linked;
        }
        parent = pruneContextPlaneLinks(parent, updated);
        if (!await canPersistAssemblyPartEdit(createAssemblyDocumentBundle(parent, updated))) {
          return isCurrent(get()) ? 'failed' : 'stale';
        }
      } catch {
        return isCurrent(get()) ? 'failed' : 'stale';
      }
      const current = get();
      if (!isCurrent(current)) return 'stale';
      current.applyAssembly(parent, updated, adopt);
      const applied = get();
      if (applied.assemblyLibrary !== updated || applied.activeDocumentId !== target.identity.activeDocumentId) return 'stale';
      if (applied.partEdit?.id === target.session && applied.numericInputRevision === target.numericInputRevision
        && applied.cancelRequestCount === target.cancelRequestCount) adopt?.onApplied?.(applied);
      return 'applied';
    },
  };
}
