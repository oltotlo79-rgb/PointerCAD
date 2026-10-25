/** P7-18: only a completed release writes component placements to one document. */
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { moveComponent, normalizeQuaternion, prepareMateDrag, solveMateDrag,
  type AssemblyDocument, type RigidPlacement, type PreparedMateDrag, type MateDragOptions,
  type MateDragOutcome, type PartLibrary, type Vec3, type WorkPlane, type MateResidualTargetPair } from '@pointercad/model';
import { componentDragTarget, finiteComponentDragVector } from '../viewport/dragComponent.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AssemblyOccurrenceDrive } from '../store/assemblyOccurrenceDriveSlice.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { coupledDragFollow, type CoupledDragOutcome } from './coupledComponentDrag.js';
import { resolveCurrentMateTarget } from './mateCommands.js';

export type AssemblyDragNotice = 'dragging' | 'fixed' | 'waiting' | 'unavailable' | 'cancelled' | 'failed' | 'complete' | 'limited';
export interface AssemblyDragState {
  readonly token: string;
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly documentId: string;
  readonly version: number;
  readonly generation: number;
  readonly view: AssemblyView;
  readonly plane: WorkPlane;
  readonly grab: Vec3;
  readonly origin: Vec3;
  readonly prepared: PreparedMateDrag;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  /** EX12: the occurrence drives shown when the drag began, given back when a coupled preview ends without a release. */
  readonly occurrenceDrives: ReadonlyMap<string, AssemblyOccurrenceDrive>;
  /** EX12: the coupled child drives the last frame published (null when the last frame turned no coupled joint). */
  readonly published: ReadonlyMap<string, AssemblyOccurrenceDrive> | null;
}
export interface AssemblyDragOverlay {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly documentId: string;
  readonly version: number;
  readonly generation: number;
  readonly placements: ReadonlyMap<string, RigidPlacement>;
  readonly validatedIds: readonly string[];
}
type DragRequestOptions = Pick<MateDragOptions, 'maxIterations' | 'maxTimeMs' | 'now'>;

/** A result belongs to one document, geometry generation and input operation. */
export function currentComponentDrag(drag: AssemblyDragState): boolean {
  const state = useAppStore.getState();
  return state.assemblyDrag?.token === drag.token && state.assembly === drag.document
    && state.assemblyLibrary === drag.library && state.activeDocumentId === drag.documentId
    && state.documentVersion === drag.version && state.requestedGeneration === drag.generation
    && state.assemblyView === drag.view && !state.isComputing && state.assemblyMateDraft === null
    && state.assemblyPlacement === null && state.selectionKind === 'body' && state.activeTool === 'select';
}

export function beginComponentDrag(componentId: string, plane: WorkPlane, grab: Vec3): boolean {
  const state = useAppStore.getState();
  const document = state.assembly, view = state.assemblyView;
  const component = document?.components.find((item) => item.id === componentId);
  const refuse = (notice: AssemblyDragNotice): false => {
    useAppStore.setState({ assemblyDragNotice: notice }); return false;
  };
  if (state.assemblyDrag !== null) return false;
  if (component?.fixed) return refuse('fixed');
  if (document === null || component === undefined || component.suppressed || !component.visible) return refuse('unavailable');
  if (view === null || view.sourceDocument !== document || state.isComputing || state.assemblyPlacement !== null
    || state.assemblyMateDraft !== null || state.selectionKind !== 'body' || state.activeTool !== 'select') return refuse('waiting');
  if (!finiteComponentDragVector(grab, 3) || !finiteComponentDragVector(plane.origin, 3)
    || !finiteComponentDragVector(plane.normal, 3)) return refuse('failed');
  try {
    const targets = new Map<string, MateResidualTargetPair>();
    for (const mate of document.mates) {
      if (mate.suppressed) continue;
      const a = resolveCurrentMateTarget(document, view, mate.a), b = resolveCurrentMateTarget(document, view, mate.b);
      if (a.ok && b.ok) targets.set(mate.id, { a: a.target, b: b.target });
    }
    const result = prepareMateDrag(document, targets, view.resolved.placements, componentId,
      { jointFrames: view.jointFrames });
    if (!result.ok) return refuse(result.reason === 'invalidInput' ? 'failed' : 'unavailable');
    const origin = result.drag.initial.get(componentId)?.position;
    if (origin === undefined) return refuse('unavailable');
    const drag: AssemblyDragState = { token: crypto.randomUUID(), document, library: state.assemblyLibrary,
      documentId: state.activeDocumentId, version: state.documentVersion, generation: state.requestedGeneration,
      view, plane, grab: [...grab], origin: [...origin], prepared: result.drag, placements: result.drag.initial,
      occurrenceDrives: state.assemblyOccurrenceDrives, published: null };
    useAppStore.setState({ assemblyDrag: drag, assemblyDragOverlay: { document, library: drag.library, documentId: drag.documentId,
      version: drag.version, generation: drag.generation, placements: drag.placements,
      validatedIds: drag.prepared.variableSet.movableComponentIds }, assemblyDragNotice: 'dragging' });
    return true;
  } catch { return refuse('failed'); }
}

/** The drives to show again when a coupled preview ends: only if nothing else replaced the ones this drag published. */
function restoredDrives(drag: AssemblyDragState): { readonly assemblyOccurrenceDrives: ReadonlyMap<string, AssemblyOccurrenceDrive> } | null {
  const state = useAppStore.getState();
  return state.assembly === drag.document && state.assemblyLibrary === drag.library
    && state.activeDocumentId === drag.documentId && state.documentVersion === drag.version
    && drag.published !== null && state.assemblyOccurrenceDrives === drag.published
    ? { assemblyOccurrenceDrives: drag.occurrenceDrives } : null;
}

/** Cancel never runs another solve and never restores an old document into a new one. */
export function cancelComponentDrag(notice: AssemblyDragNotice = 'cancelled'): void {
  const drag = useAppStore.getState().assemblyDrag;
  if (drag !== null) cancelOwnedComponentDrag(drag, notice);
}

/** A completed or interrupted request may cancel only the input operation it captured. */
function cancelOwnedComponentDrag(drag: AssemblyDragState, notice: AssemblyDragNotice = 'cancelled'): void {
  if (useAppStore.getState().assemblyDrag?.token !== drag.token) return;
  useAppStore.setState({ assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: notice, ...restoredDrives(drag) });
}

function confinedPlacements(drag: AssemblyDragState, placements: ReadonlyMap<string, RigidPlacement>): boolean {
  const movable = new Set(drag.prepared.variableSet.movableComponentIds);
  for (const [id, original] of drag.prepared.initial) {
    const placement = placements.get(id);
    if (placement === undefined || !validPlacement(placement)) return false;
    if (!movable.has(id) && (!placement.position.every((n, axis) => n === original.position[axis])
      || !placement.rotation.every((n, axis) => n === original.rotation[axis]))) return false;
  }
  return placements.size === drag.prepared.initial.size;
}

interface DragStep {
  readonly result: MateDragOutcome;
  readonly coupled: Exclude<CoupledDragOutcome, { readonly kind: 'refused' }>;
}

function requestComponentDrag(pointer: Vec3, phase: 'frame' | 'release', options: DragRequestOptions): DragStep | null {
  const drag = useAppStore.getState().assemblyDrag;
  if (drag === null) return null;
  if (!currentComponentDrag(drag)) { cancelOwnedComponentDrag(drag); return null; }
  const target = componentDragTarget(drag.origin, drag.grab, pointer);
  if (target === null) { cancelOwnedComponentDrag(drag, 'failed'); return null; }
  try {
    const result = solveMateDrag(drag.prepared, target, { ...options, phase,
      maxIterations: options.maxIterations ?? (phase === 'frame' ? 5 : 50), placements: drag.placements,
      shouldCancel: () => !currentComponentDrag(drag) });
    if (!currentComponentDrag(drag)) { cancelOwnedComponentDrag(drag); return null; }
    if (!result.hardSatisfied || !confinedPlacements(drag, result.placements)) {
      if (phase === 'release') cancelOwnedComponentDrag(drag, 'failed');
      else useAppStore.setState({ assemblyDragNotice: 'failed' });
      return null;
    }
    // EX12: a drag that turns the parent joint of a saved cross-level gear or the joint of a saved cam carries every
    // coupled child (the same follow as every other parent-level motion), or is refused whole with the reason shown.
    const coupled = coupledDragFollow({ document: drag.document, view: drag.view, initial: drag.prepared.initial }, result.placements);
    if (coupled.kind === 'refused') {
      useAppStore.setState({ assemblyCrossLevelMotionNotice: coupled.notice });
      if (phase === 'release') cancelOwnedComponentDrag(drag, 'failed');
      else useAppStore.setState({ assemblyDragNotice: 'failed' });
      return null;
    }
    if (phase === 'frame') {
      // The parent preview and its coupled children in one update; a frame that turns no coupled joint shows the drives
      // of the drag start again.
      const drives = coupled.kind === 'coupled' ? { assemblyOccurrenceDrives: coupled.drives, assemblyCrossLevelMotionNotice: null }
        : restoredDrives(drag);
      useAppStore.setState({ assemblyDrag: { ...drag, placements: result.placements, published: coupled.kind === 'coupled' ? coupled.drives : null },
        assemblyDragOverlay: { document: drag.document, library: drag.library, documentId: drag.documentId, version: drag.version,
          generation: drag.generation, placements: result.placements, validatedIds: drag.prepared.variableSet.movableComponentIds },
        assemblyDragNotice: result.stop === 'stationary' ? 'limited' : 'dragging', ...drives });
    }
    return { result, coupled };
  } catch { cancelOwnedComponentDrag(drag, 'failed'); return null; }
}

export function moveComponentDrag(pointer: Vec3, options: DragRequestOptions = {}): MateDragOutcome | null {
  return requestComponentDrag(pointer, 'frame', options)?.result ?? null;
}

export function finishComponentDrag(pointer: Vec3, options: DragRequestOptions = {}): boolean {
  const drag = useAppStore.getState().assemblyDrag;
  if (drag === null) return false;
  const step = requestComponentDrag(pointer, 'release', options);
  if (step === null || !step.result.committable || !currentComponentDrag(drag)) { cancelOwnedComponentDrag(drag, 'failed'); return false; }
  const result = step.result;
  if (step.coupled.kind === 'coupled') {
    // EX12: joint motion, not a placement edit. The parent placements, the reached joint values and every coupled child
    // are published together like a joint drive: no document edit, no Undo step, not saved.
    useAppStore.setState({ assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: null,
      assemblyMotionTime: 0, assemblyMotionPlaying: false, assemblyMotionPlacements: result.placements,
      assemblyMotionSourceDocument: drag.document, assemblyMotionJointValues: step.coupled.values, assemblyMotionNotice: null,
      // A running cooperative top-level drive no longer owns the motion (it checks assemblyJointDrive before each slice).
      assemblyJointDrive: null, assemblyOccurrenceDrives: step.coupled.drives, assemblyCrossLevelMotionNotice: null });
    return true;
  }
  const document = componentDragDocument(drag.document, drag.prepared.initial, result.placements);
  if (document === null) { cancelOwnedComponentDrag(drag, 'failed'); return false; }
  // End the session before subscribers or capture release can deliver another end event.
  useAppStore.setState({ assemblyDrag: null,
    assemblyDragOverlay: document === drag.document ? null : { document, library: drag.library, documentId: drag.documentId,
      version: drag.version, generation: drag.generation + 1, placements: result.placements,
      validatedIds: drag.prepared.variableSet.movableComponentIds },
    assemblyDragNotice: result.stop === 'stationary' ? 'limited' : document === drag.document ? null : 'complete',
    ...restoredDrives(drag) });
  if (document !== drag.document) useAppStore.getState().applyAssembly(document);
  return true;
}

/** Overlay belongs to the current document; never use it as a geometry/shape cache. */
export function componentDragPlacements(state: ReturnType<typeof useAppStore.getState>): ReadonlyMap<string, RigidPlacement> | undefined {
  const overlay = state.assemblyDragOverlay;
  return overlay !== null && overlay.document === state.assembly && overlay.library === state.assemblyLibrary && overlay.documentId === state.activeDocumentId
    && overlay.version === state.documentVersion && overlay.generation === state.requestedGeneration
    ? overlay.placements : state.assemblyView?.resolved.placements;
}

function validPlacement(placement: RigidPlacement): boolean {
  if (!finiteComponentDragVector(placement.position, 3) || !finiteComponentDragVector(placement.rotation, 4)) return false;
  const norm = Math.hypot(...placement.rotation);
  return Number.isFinite(norm) && norm > 1e-12;
}

/** Compare with the displayed start, preserving untouched stored expressions and fields. */
export function componentDragDocument(document: AssemblyDocument,
  initial: ReadonlyMap<string, RigidPlacement>, placements: ReadonlyMap<string, RigidPlacement>): AssemblyDocument | null {
  let result = document;
  for (const component of document.components) {
    if (component.suppressed) continue;
    const before = initial.get(component.id), after = placements.get(component.id);
    if (before === undefined || after === undefined || !validPlacement(before) || !validPlacement(after)) return null;
    const rotation = normalizeQuaternion(after.rotation), originalRotation = normalizeQuaternion(before.rotation);
    const sameRotation = rotation.every((value, axis) => value === originalRotation[axis]);
    const samePosition = after.position.every((value, axis) => value === before.position[axis]);
    if (samePosition && sameRotation) continue;
    if (component.fixed) return null;
    const position = (axis: 0 | 1 | 2) => after.position[axis] === before.position[axis]
      ? component.placement.position[axis] : exactExpressionValueFromNumber(after.position[axis]);
    result = moveComponent(result, component.id, { position: [position(0), position(1), position(2)],
      rotation: sameRotation ? component.placement.rotation : rotation });
  }
  return result;
}
