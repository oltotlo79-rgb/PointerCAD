/**
 * Shared selection checks for operations on selected existing points: the two-point connection
 * (R29) and the face through three or more points (R30). Both use the same document, current
 * result, selection-proof and reference checks; only the counts and messages differ.
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { createSubShapeReferenceResolver, FREE_WORK_PLANE_ID, type CoordinateInput, type Vec3 } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import { hasCurrentConnectionGeometry, isCurrentConnectionEndpoint } from './connectionSelection.js';
import { subShapeCoordinate } from './sketchCommands.js';

export interface SelectedPointEnd {
  readonly position: Vec3;
  /** Zero offset from the original point or vertex reference; the saved reference is not changed. */
  readonly coordinate: CoordinateInput;
  readonly planeId: string;
}

/** Messages that name the operation; the remaining reasons are shared. */
export interface SelectedPointReasons {
  readonly computing: MessageKey;
  readonly reselect: MessageKey;
  readonly pointFeaturesOnly: MessageKey;
  readonly otherSketch: MessageKey;
}

export type SelectedPointEnds =
  | { readonly ok: true; readonly ends: readonly SelectedPointEnd[] }
  | { readonly ok: false; readonly reasonKey: MessageKey };

export function pointReferenceCoordinate(pointId: string): CoordinateInput {
  const zero = expressionValueFromNumber(0);
  return { mode: 'relative', base: { kind: 'point', pointId }, dx: zero, dy: zero, dz: zero };
}

/** A selected item that names a point: certified, a solid vertex, or a point of the active sketch. */
export function isPointLikeSelection(state: AppState, id: string): boolean {
  return state.connectionSelection?.endpoints.has(id) === true || parseSubShapeId(id)?.kind === 'vertex'
    || state.sketch.features.some(feature => feature.id === id && feature.kind === 'point');
}

/** The number shown next to the reason, e.g. "1/2". */
export function pointSelectionCount(state: AppState): number {
  return state.selection.filter(id => isPointLikeSelection(state, id)).length;
}

/** Document kind, completed result and input ownership, before the count is examined. */
export function pointSelectionStateRefusal(state: AppState, computing: MessageKey): MessageKey | null {
  if (activeDocumentKind(state) !== 'part') return 'command.unavailable.document';
  if (state.isComputing || state.requestedGeneration !== state.completedGeneration) return computing;
  if (state.activeTool !== 'select' || state.numericInput !== null || state.sketchDrag !== null
    || state.activeConstraintKind !== null || state.timelineIndex !== null || state.commandLineFocused) {
    return 'sketch.connect.editing';
  }
  return hasCurrentConnectionGeometry(state) ? null : 'sketch.connect.unresolved';
}

/**
 * Each selected item must carry a current certificate from its actual source. Sketch points are read
 * from the current result; vertices are re-resolved from the original reference on the current body.
 */
export function resolveSelectedPointEnds(state: AppState, reasons: SelectedPointReasons): SelectedPointEnds {
  if (state.connectionSelection?.selection !== state.selection) return { ok: false, reasonKey: reasons.reselect };
  const ends: SelectedPointEnd[] = [];
  const resolve = createSubShapeReferenceResolver();
  for (const id of state.selection) {
    const endpoint = state.connectionSelection.endpoints.get(id);
    if (endpoint === undefined) return { ok: false, reasonKey: parseSubShapeId(id)?.kind === 'vertex'
      || state.sketch.features.some(feature => feature.id === id && feature.kind === 'point')
      ? reasons.reselect : reasons.pointFeaturesOnly };
    if (endpoint.kind === 'point' && endpoint.sketchId !== state.sketch.id) return { ok: false, reasonKey: reasons.otherSketch };
    if (!isCurrentConnectionEndpoint(state, endpoint)) return { ok: false, reasonKey: reasons.reselect };
    if (endpoint.kind === 'point') {
      const feature = state.sketch.features.find(value => value.id === endpoint.pointId && value.kind === 'point');
      const point = state.resolvedSketch.points.find(value => value.id === endpoint.pointId && value.featureId === endpoint.pointId);
      if (feature === undefined || point === undefined || state.resolvedSketch.errors.some(error => error.featureId === id)) {
        return { ok: false, reasonKey: 'sketch.connect.unresolved' };
      }
      ends.push({ position: point.position, coordinate: pointReferenceCoordinate(endpoint.pointId), planeId: feature.planeId });
    } else {
      const reference = endpoint.originalReference;
      const bodies = state.bodies.filter(body => body.featureId === reference.bodyFeatureId && body.isValid);
      if (bodies.length !== 1 || !state.document.solids.some(solid => solid.id === reference.bodyFeatureId && !solid.suppressed)) {
        return { ok: false, reasonKey: 'sketch.connect.missing' };
      }
      const result = resolve(bodies[0], reference);
      if (result.status === 'ambiguous') return { ok: false, reasonKey: 'sketch.connect.ambiguous' };
      if (result.status !== 'matched' || result.match.geometry.kind !== 'vertex') {
        return { ok: false, reasonKey: 'sketch.connect.missing' };
      }
      ends.push({ position: result.match.geometry.position, coordinate: subShapeCoordinate(reference), planeId: FREE_WORK_PLANE_ID });
    }
  }
  if (!ends.every(end => end.position.every(Number.isFinite))) return { ok: false, reasonKey: 'sketch.connect.unresolved' };
  return { ok: true, ends };
}

/** One work plane when every end shares it; otherwise the free 3D plane. */
export function commonPlaneId(ends: readonly SelectedPointEnd[]): string {
  return ends.every(end => end.planeId === ends[0].planeId) ? ends[0].planeId : FREE_WORK_PLANE_ID;
}
