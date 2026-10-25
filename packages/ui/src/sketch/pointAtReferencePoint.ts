import { appendFeature, createPointFeature, replaceSketch, type SketchPointFeature } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { pointReferenceCoordinate } from './selectedPointEnds.js';

/**
 * EX-18 route 5 user entry: with one part reference point selected (for example the point an assembly-context link
 * drives), add a sketch point in the active sketch that follows it (relative 0,0,0 to that reference point). The saved
 * link is the existing PointReference kind 'point'; the model resolves it through the part reference-point bridge.
 */
export type PointAtReferenceResult =
  | { readonly ready: true; readonly reasonKey: null; readonly point: SketchPointFeature }
  | { readonly ready: false; readonly reasonKey: MessageKey };

export function pointAtReferenceDecision(state: AppState = useAppStore.getState()): PointAtReferenceResult {
  // The same document, computation and input-ownership checks as the selected-point commands (selectedPointEnds.ts),
  // without the sketch-point geometry certificate, which a part reference point does not have.
  if (activeDocumentKind(state) !== 'part') return { ready: false, reasonKey: 'command.unavailable.document' };
  if (state.isComputing || state.requestedGeneration !== state.completedGeneration) {
    return { ready: false, reasonKey: 'sketch.referencePoint.computing' };
  }
  if (state.activeTool !== 'select' || state.numericInput !== null || state.sketchDrag !== null
    || state.activeConstraintKind !== null || state.timelineIndex !== null || state.commandLineFocused) {
    return { ready: false, reasonKey: 'sketch.connect.editing' };
  }
  if (state.selection.length !== 1) return { ready: false, reasonKey: 'sketch.referencePoint.selectOne' };
  const [id] = state.selection;
  const feature = state.document.references.find((reference) => reference.id === id);
  if (feature?.kind !== 'referencePoint') return { ready: false, reasonKey: 'sketch.referencePoint.selectOne' };
  // The bridge only follows reference points fixed by an absolute coordinate (others could cycle through solids).
  if (feature.definition.kind !== 'coordinate' || feature.definition.at.mode !== 'absolute') {
    return { ready: false, reasonKey: 'sketch.referencePoint.unsupported' };
  }
  // A sketch feature with the same id would make the reference ambiguous; the model refuses it, so refuse here too.
  if (state.document.sketches.some((sketch) => sketch.features.some((candidate) => candidate.id === id))) {
    return { ready: false, reasonKey: 'sketch.referencePoint.ambiguous' };
  }
  return { ready: true, reasonKey: null, point: createPointFeature(state.sketch, pointReferenceCoordinate(id)) };
}

/** Revalidate immediately before the single undoable document update. */
export function placePointAtReferencePoint(): PointAtReferenceResult {
  const state = useAppStore.getState();
  const result = pointAtReferenceDecision(state);
  if (!result.ready) return result;
  state.applyDocument(replaceSketch(state.document, appendFeature(state.sketch, result.point)));
  state.setSelection([result.point.id]);
  state.setEditNotice('sketch.referencePoint.created');
  return result;
}
