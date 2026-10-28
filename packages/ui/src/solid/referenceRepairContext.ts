import type { SolidBody, SubShapeRef } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activeDocument } from '../store/documentKind.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { assemblyRepairSlots } from './referenceRepairAssembly.js';
import { drawingRepairSlots } from './referenceRepairDrawing.js';
import { partRepairSlots, type RepairSlot } from './referenceRepairSlots.js';
import { subShapeElementId } from './subShapeSelection.js';
import { drawingRepairHoverId } from '../drawing/referenceRepairProjection.js';

export interface CurrentRepairSlot extends Omit<RepairSlot<never>, 'replace'> {
  readonly bodies: readonly SolidBody[];
  readonly available: boolean;
  readonly apply: (state: AppState, reference: SubShapeRef) => void;
  readonly hoverId: (reference: SubShapeRef, sessionOwner: object) => string | null;
}

export function repairContextTokens(state: AppState): readonly unknown[] {
  const active = activeDocument(state);
  return [active.kind, active.document, state.activeDocumentId, state.documentVersion, state.bodies,
    state.requestedGeneration, state.completedGeneration, state.cancelRequestCount, state.isComputing,
    state.lastOutcome, state.recomputeCancelled, state.timelineIndex, state.assemblyLibrary, state.assemblyView,
    state.drawingSources, state.drawingResolution, state.drawingSourceResolution, state.drawingBusy, state.partErrors, state.mathGeometryResult, state.referenceRepairBodies];
}

export function repairContextReady(state: AppState): boolean {
  const active = activeDocument(state);
  if (active.kind === 'drawing') return !state.drawingBusy && state.drawingSourceResolution !== null
    && state.drawingResolution?.ok === true && state.drawingResolution.document === active.document;
  if (active.kind === 'assembly') return !state.isComputing && state.assemblyView?.sourceDocument === active.document;
  return !state.isComputing && !state.recomputeCancelled && state.timelineIndex === null
    && state.completedGeneration > 0 && state.requestedGeneration === state.completedGeneration
    && (state.lastOutcome === 'success' || state.lastOutcome === 'failed');
}

/** 現文書・同世代の表示bodyと、実scopeが所有する中間bodyだけを借りる。保存参照は変更しない。 */
export function currentPartReferenceBodies(state: AppState): readonly SolidBody[] {
  const active = activeDocument(state);
  if (active.kind !== 'part') return [];
  const snapshot = state.referenceRepairBodies;
  const upstream = snapshot !== null && snapshot.scope.current && snapshot.document === active.document
    && snapshot.scope.document === active.document && snapshot.scope.context.generation === snapshot.generation
    && snapshot.activeDocumentId === state.activeDocumentId && snapshot.generation === state.completedGeneration
    && snapshot.generation === state.requestedGeneration && snapshot.displayBodies === state.bodies
    ? snapshot.bodies.filter(body => state.bodies.includes(body) || snapshot.scope.referenceBodyCurrent(body)) : [];
  return [...new Set([...state.bodies, ...upstream])];
}

export function currentRepairSlots(state: AppState): readonly CurrentRepairSlot[] {
  const active = activeDocument(state);
  const hoverId = (ref: SubShapeRef): string => subShapeElementId(ref.bodyFeatureId, ref.fingerprint.kind, ref.index);
  if (active.kind === 'part') {
    const currentBodies = currentPartReferenceBodies(state);
    return partRepairSlots(active.document).map(slot => ({ ...slot,
    bodies: currentBodies.filter(body => !state.partErrors.some(error => error.featureId === body.featureId)), hoverId,
    available: currentBodies.some(body => body.featureId === slot.reference.bodyFeatureId)
      || !active.document.solids.some(feature => feature.id === slot.reference.bodyFeatureId && !feature.suppressed)
      || state.partErrors.some(error => error.featureId === slot.reference.bodyFeatureId),
    apply: (state, ref) => { state.applyDocument(slot.replace(ref)); } }));
  }
  if (active.kind === 'assembly') return assemblyRepairSlots(active.document).map(slot => {
    const component = active.document.components.find(item => item.id === slot.componentId);
    const partKey = slot.componentId === undefined ? undefined : state.assemblyView?.resolved.partKeys.get(slot.componentId);
    const view = state.assemblyView, ownership = view?.meshOwnership;
    const source = partKey === undefined ? undefined : ownership?.sources.get(partKey);
    // Borrow only the exact current source result. The display path and its admission stay separate.
    const upstream = source !== undefined && ownership !== undefined && view?.sourceDocument === active.document
      && ownership.document === active.document && ownership.library === state.assemblyLibrary
      && ownership.activeDocumentId === state.activeDocumentId && ownership.documentVersion === state.documentVersion
      && ownership.generation === state.completedGeneration && ownership.generation === state.requestedGeneration
      && ownership.publicationCurrent() && source.current() && !source.result.cancelled
      && source.result.referenceMeshScope?.current === true
      && source.result.referenceMeshScope.document === source.document
      && source.result.referenceMeshScope.context.generation === source.result.generation
      && source.result.referenceBodies !== undefined ? source.result.referenceBodies.filter(body =>
        !source.result.errors.some(error => error.featureId === body.featureId)
        && source.result.referenceMeshScope?.referenceBodyCurrent?.(body) === true) : [];
    const currentBodies = [...new Set([...(partKey === undefined ? [] : view?.bodies.get(partKey) ?? []), ...upstream])];
    return { ...slot, available: true,
      bodies: component === undefined || component.suppressed || partKey === undefined
        || view?.resolved.errors.some(error => error.componentId === component.id) ? [] : currentBodies,
      hoverId: ref => assemblyTargetId({ kind: 'subShape', componentId: slot.componentId ?? '', ref }),
      apply: (state, ref) => { state.applyAssembly(slot.replace(ref)); } };
  });
  return drawingRepairSlots(active.document).map(slot => ({ ...slot, available: true,
    bodies: (state.drawingSourceResolution?.dimensionInstances ?? []).filter(instance => instance.sourceRef === slot.sourceRef
      && instance.componentId === slot.componentId).map(instance => instance.body),
    hoverId: (ref, sessionOwner) => drawingRepairHoverId(state, slot, ref, sessionOwner),
    apply: (state, ref) => { state.applyDrawing(slot.replace(ref)); } }));
}
