/**
 * A face through three or more selected existing points (R30, FR-309/FR-330).
 *
 * The selection proof, the current-result checks and the end coordinates are shared with the
 * two-point connection (R29) in `selectedPointEnds.ts`. The result is one closed outline of new
 * lines that refer to the original points with zero offsets, and one existing `face` feature
 * whose boundary is that outline. Both are published by a single document update.
 */
import { appendFeature, DEFAULT_FACE_COLOR, nextFeatureId, nextFeatureName, replaceSketch, type SketchDocument,
  type SketchFaceFeature, type SketchLineFeature, type Vec3 } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { MIN_FACE_CORNERS, orderFacePoints, type FacePointOrder, type FacePointOrderRefusal } from './facePointOrder.js';
import { commonPlaneId, isPointLikeSelection, pointSelectionCount, pointSelectionStateRefusal, resolveSelectedPointEnds,
  type SelectedPointEnd, type SelectedPointReasons } from './selectedPointEnds.js';

export type FaceCorner = SelectedPointEnd;

export interface FacePlan {
  /** Corners in the selection order. */
  readonly corners: readonly FaceCorner[];
  /** Indices into `corners` in the order the outline visits them. */
  readonly order: readonly number[];
  readonly reordered: boolean;
  readonly planeId: string;
}

type FaceDecision =
  | { readonly ready: true; readonly reasonKey: null; readonly plan: FacePlan }
  | { readonly ready: false; readonly reasonKey: MessageKey };
export type FacePointsDecision = FaceDecision & { readonly showInMenu: boolean; readonly pointCount: number };
export type FacePointsResult =
  | { readonly ready: true; readonly reasonKey: null; readonly showInMenu: boolean; readonly pointCount: number;
    readonly lines: readonly SketchLineFeature[]; readonly face: SketchFaceFeature; readonly reordered: boolean }
  | { readonly ready: false; readonly reasonKey: MessageKey; readonly showInMenu: boolean; readonly pointCount: number };

const FACE_REASONS: SelectedPointReasons = {
  computing: 'sketch.facePoints.computing',
  reselect: 'sketch.facePoints.reselect',
  pointFeaturesOnly: 'sketch.facePoints.pointFeaturesOnly',
  otherSketch: 'sketch.facePoints.otherSketch',
};

const ORDER_REASONS: Readonly<Record<FacePointOrderRefusal, MessageKey>> = {
  samePoint: 'sketch.facePoints.samePoint',
  collinear: 'sketch.facePoints.collinear',
  notPlanar: 'sketch.facePoints.notPlanar',
  selfIntersecting: 'sketch.facePoints.selfIntersecting',
};

/** The order test is quadratic; reuse it while the same corner positions are asked repeatedly. */
let lastOrder: { readonly positions: readonly Vec3[]; readonly result: FacePointOrder } | null = null;
function cachedOrder(positions: readonly Vec3[]): FacePointOrder {
  const previous = lastOrder;
  if (previous !== null && previous.positions.length === positions.length
    && previous.positions.every((position, index) => position.every((value, axis) => value === positions[index][axis]))) {
    return previous.result;
  }
  const result = orderFacePoints(positions);
  lastOrder = { positions: positions.map(position => [...position] as const), result };
  return result;
}

/** The same current-result, selection-proof and reference checks as the two-point connection. */
function faceDecision(state: AppState): FaceDecision {
  const refusal = pointSelectionStateRefusal(state, FACE_REASONS.computing);
  if (refusal !== null) return { ready: false, reasonKey: refusal };
  if (state.selection.length < MIN_FACE_CORNERS) return { ready: false, reasonKey: 'sketch.facePoints.selectThree' };
  if (new Set(state.selection).size !== state.selection.length) return { ready: false, reasonKey: 'sketch.facePoints.samePoint' };
  const resolved = resolveSelectedPointEnds(state, FACE_REASONS);
  if (!resolved.ok) return { ready: false, reasonKey: resolved.reasonKey };
  const corners = resolved.ends;
  const ordered = cachedOrder(corners.map(corner => corner.position));
  if (!ordered.ok) return { ready: false, reasonKey: ORDER_REASONS[ordered.reason] };
  return { ready: true, reasonKey: null,
    plan: { corners, order: ordered.order, reordered: ordered.reordered, planeId: commonPlaneId(corners) } };
}

/** The closing line returns to the first corner, so the face boundary is one closed loop. */
export function buildFaceFromPoints(sketch: SketchDocument, plan: FacePlan): {
  readonly sketch: SketchDocument; readonly lines: readonly SketchLineFeature[]; readonly face: SketchFaceFeature;
} {
  let next = sketch;
  const lines: SketchLineFeature[] = [];
  for (const [position, index] of plan.order.entries()) {
    const line: SketchLineFeature = {
      id: nextFeatureId(next, 'line'), name: nextFeatureName(next, 'line'), kind: 'line', construction: false,
      planeId: plan.planeId, from: plan.corners[index].coordinate,
      to: plan.corners[plan.order[(position + 1) % plan.order.length]].coordinate,
    };
    next = appendFeature(next, line);
    lines.push(line);
  }
  const face: SketchFaceFeature = {
    id: nextFeatureId(next, 'face'), name: nextFeatureName(next, 'face'), kind: 'face', planeId: plan.planeId,
    boundary: lines.map(line => ({ featureId: line.id })), color: DEFAULT_FACE_COLOR,
  };
  return { sketch: appendFeature(next, face), lines, face };
}

/** Shown in place of the two-point connection when three or more items include a point. */
export function selectedPointsFace(state: AppState = useAppStore.getState()): FacePointsDecision {
  const showInMenu = state.selection.length >= MIN_FACE_CORNERS && state.selection.some(id => isPointLikeSelection(state, id));
  return { ...faceDecision(state), showInMenu, pointCount: pointSelectionCount(state) };
}

/** Revalidate immediately before the single undoable document update. */
export function faceFromSelectedPoints(): FacePointsResult {
  const state = useAppStore.getState();
  const decision = selectedPointsFace(state);
  if (!decision.ready) return decision;
  const built = buildFaceFromPoints(state.sketch, decision.plan);
  state.applyDocument(replaceSketch(state.document, built.sketch));
  state.setSelection([built.face.id]);
  state.setEditNotice(decision.plan.reordered ? 'sketch.facePoints.createdReordered' : 'sketch.facePoints.created');
  return { ready: true, reasonKey: null, showInMenu: decision.showInMenu, pointCount: decision.pointCount,
    lines: built.lines, face: built.face, reordered: decision.plan.reordered };
}
