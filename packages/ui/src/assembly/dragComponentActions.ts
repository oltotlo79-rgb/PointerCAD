/** P7-18: only a completed release writes component placements to one document. */
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { moveComponent, normalizeQuaternion, prepareMateDrag, solveMateDrag,
  type AssemblyDocument, type RigidPlacement, type PreparedMateDrag, type MateDragOptions,
  type MateDragOutcome, type PartLibrary, type Vec3, type WorkPlane, type MateResidualTargetPair } from '@pointercad/model';
import { componentDragTarget, finiteComponentDragVector } from '../viewport/dragComponent.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AssemblyView } from '../store/assemblySlice.js';
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
    const result = prepareMateDrag(document, targets, view.resolved.placements, componentId);
    if (!result.ok) return refuse(result.reason === 'invalidInput' ? 'failed' : 'unavailable');
    const origin = result.drag.initial.get(componentId)?.position;
    if (origin === undefined) return refuse('unavailable');
    const drag: AssemblyDragState = { token: crypto.randomUUID(), document, library: state.assemblyLibrary,
      documentId: state.activeDocumentId, version: state.documentVersion, generation: state.requestedGeneration,
      view, plane, grab: [...grab], origin: [...origin], prepared: result.drag, placements: result.drag.initial };
    useAppStore.setState({ assemblyDrag: drag, assemblyDragOverlay: { document, library: drag.library, documentId: drag.documentId,
      version: drag.version, generation: drag.generation, placements: drag.placements,
      validatedIds: drag.prepared.variableSet.movableComponentIds }, assemblyDragNotice: 'dragging' });
    return true;
  } catch { return refuse('failed'); }
}

/** Cancel never runs another solve and never restores an old document into a new one. */
export function cancelComponentDrag(notice: AssemblyDragNotice = 'cancelled'): void {
  if (useAppStore.getState().assemblyDrag === null) return;
  useAppStore.setState({ assemblyDrag: null, assemblyDragOverlay: null, assemblyDragNotice: notice });
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

function requestComponentDrag(pointer: Vec3, phase: 'frame' | 'release', options: DragRequestOptions): MateDragOutcome | null {
  const drag = useAppStore.getState().assemblyDrag;
  if (drag === null) return null;
  if (!currentComponentDrag(drag)) { cancelComponentDrag(); return null; }
  const target = componentDragTarget(drag.origin, drag.grab, pointer);
  if (target === null) { cancelComponentDrag('failed'); return null; }
  try {
    const result = solveMateDrag(drag.prepared, target, { ...options, phase,
      maxIterations: options.maxIterations ?? (phase === 'frame' ? 5 : 50), placements: drag.placements,
      shouldCancel: () => !currentComponentDrag(drag) });
    if (!currentComponentDrag(drag)) { cancelComponentDrag(); return null; }
    if (!result.hardSatisfied || !confinedPlacements(drag, result.placements)) {
      if (phase === 'release') cancelComponentDrag('failed');
      else useAppStore.setState({ assemblyDragNotice: 'failed' });
      return null;
    }
    if (phase === 'frame') {
      useAppStore.setState({ assemblyDrag: { ...drag, placements: result.placements },
        assemblyDragOverlay: { document: drag.document, library: drag.library, documentId: drag.documentId, version: drag.version,
          generation: drag.generation, placements: result.placements, validatedIds: drag.prepared.variableSet.movableComponentIds },
        assemblyDragNotice: result.stop === 'stationary' ? 'limited' : 'dragging' });
    }
    return result;
  } catch { cancelComponentDrag('failed'); return null; }
}

export function moveComponentDrag(pointer: Vec3, options: DragRequestOptions = {}): MateDragOutcome | null {
  return requestComponentDrag(pointer, 'frame', options);
}

export function finishComponentDrag(pointer: Vec3, options: DragRequestOptions = {}): boolean {
  const drag = useAppStore.getState().assemblyDrag;
  if (drag === null) return false;
  const result = requestComponentDrag(pointer, 'release', options);
  if (result === null || !result.committable || !currentComponentDrag(drag)) { cancelComponentDrag('failed'); return false; }
  const document = componentDragDocument(drag.document, drag.prepared.initial, result.placements);
  if (document === null) { cancelComponentDrag('failed'); return false; }
  // End the session before subscribers or capture release can deliver another end event.
  useAppStore.setState({ assemblyDrag: null,
    assemblyDragOverlay: document === drag.document ? null : { document, library: drag.library, documentId: drag.documentId,
      version: drag.version, generation: drag.generation + 1, placements: result.placements,
      validatedIds: drag.prepared.variableSet.movableComponentIds },
    assemblyDragNotice: result.stop === 'stationary' ? 'limited' : document === drag.document ? null : 'complete' });
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
