import { appendFeature, FREE_WORK_PLANE_ID, nextFeatureId, nextFeatureName, replaceSketch, SKETCH_TOLERANCE_MM,
  type ResolvedSketch, type SketchDocument, type SketchLineFeature } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { commonPlaneId, isPointLikeSelection, pointReferenceCoordinate, pointSelectionCount, pointSelectionStateRefusal,
  resolveSelectedPointEnds, type SelectedPointReasons } from './selectedPointEnds.js';

type PreparedConnection =
  | { readonly ready: true; readonly reasonKey: null; readonly line: SketchLineFeature }
  | { readonly ready: false; readonly reasonKey: MessageKey };
export type ConnectPointsResult = PreparedConnection & { readonly showInMenu: boolean; readonly pointCount: number };

const CONNECT_REASONS: SelectedPointReasons = {
  computing: 'sketch.connect.computing',
  reselect: 'sketch.connect.reselect',
  pointFeaturesOnly: 'sketch.connect.pointFeaturesOnly',
  otherSketch: 'sketch.connect.otherSketch',
};

/** Selection order defines the two ends. Only existing point features in this sketch are accepted. */
export function prepareConnectedPoints(sketch: SketchDocument, resolved: ResolvedSketch,
  selection: readonly string[]): PreparedConnection {
  if (selection.length !== 2) return { ready: false, reasonKey: 'sketch.connect.selectTwo' };
  if (selection[0] === selection[1]) return { ready: false, reasonKey: 'sketch.connect.samePoint' };
  const first = sketch.features.find(feature => feature.id === selection[0]);
  const second = sketch.features.find(feature => feature.id === selection[1]);
  if (first?.kind !== 'point' || second?.kind !== 'point') {
    return { ready: false, reasonKey: 'sketch.connect.pointFeaturesOnly' };
  }
  const start = resolved.points.find(point => point.id === first.id && point.featureId === first.id);
  const end = resolved.points.find(point => point.id === second.id && point.featureId === second.id);
  if (start === undefined || end === undefined || ![...start.position, ...end.position].every(Number.isFinite)
    || resolved.errors.some(error => selection.includes(error.featureId))) {
    return { ready: false, reasonKey: 'sketch.connect.unresolved' };
  }
  if (Math.hypot(...start.position.map((value, axis) => value - end.position[axis])) <= SKETCH_TOLERANCE_MM) {
    return { ready: false, reasonKey: 'sketch.connect.samePoint' };
  }
  return { ready: true, reasonKey: null, line: {
    id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), kind: 'line',
    planeId: first.planeId === second.planeId ? first.planeId : FREE_WORK_PLANE_ID,
    from: pointReferenceCoordinate(first.id), to: pointReferenceCoordinate(second.id), construction: false,
  } };
}

/** The existing computation snapshot binds resolved geometry to its document and active sketch. */
function connectionDecision(state: AppState): PreparedConnection {
  const refusal = pointSelectionStateRefusal(state, CONNECT_REASONS.computing);
  if (refusal !== null) return { ready: false, reasonKey: refusal };
  if (state.selection.length !== 2) return { ready: false, reasonKey: 'sketch.connect.selectTwo' };
  if (state.selection[0] === state.selection[1]) return { ready: false, reasonKey: 'sketch.connect.samePoint' };
  const resolved = resolveSelectedPointEnds(state, CONNECT_REASONS);
  if (!resolved.ok) return { ready: false, reasonKey: resolved.reasonKey };
  const [start, end] = resolved.ends;
  if (Math.hypot(...start.position.map((value, axis) => value - end.position[axis])) <= SKETCH_TOLERANCE_MM) {
    return { ready: false, reasonKey: 'sketch.connect.samePoint' };
  }
  return { ready: true, reasonKey: null, line: {
    id: nextFeatureId(state.sketch, 'line'), name: nextFeatureName(state.sketch, 'line'), kind: 'line', construction: false,
    planeId: commonPlaneId(resolved.ends), from: start.coordinate, to: end.coordinate,
  } };
}

export function selectedPointsConnection(state: AppState = useAppStore.getState()): ConnectPointsResult {
  const showInMenu = state.selection.some(id => isPointLikeSelection(state, id));
  return { ...connectionDecision(state), showInMenu, pointCount: pointSelectionCount(state) };
}

/** Revalidate immediately before the single undoable document update. */
export function connectSelectedPoints(): ConnectPointsResult {
  const state = useAppStore.getState();
  const result = selectedPointsConnection(state);
  if (!result.ready) return result;
  state.applyDocument(replaceSketch(state.document, appendFeature(state.sketch, result.line)));
  state.setSelection([result.line.id]);
  state.setEditNotice('sketch.connect.created');
  return result;
}
