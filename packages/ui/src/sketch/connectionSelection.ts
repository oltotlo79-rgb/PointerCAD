/** Selection provenance is ephemeral; saved coordinates keep only model references. */
import { affectsShape, resolveSubShapeReference, type SubShapeRef, type Vec3 } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activeDocumentKind } from '../store/documentKind.js';
import type { ResolvedSelectionSetReference } from '../solid/selectionSetCommands.js';
import { parseSubShapeId, subShapeBodiesOf, subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import { PICK_RADIUS_PIXELS } from './pickMath.js';
import type { ProjectToScreen } from './snapMath.js';

export type SelectionSource =
  | { readonly kind: 'sketch'; readonly sketchId: string }
  | { readonly kind: 'pick' }
  | { readonly kind: 'references'; readonly references: readonly ResolvedSelectionSetReference[] };

type SelectionOwner = Pick<AppState, 'activeDocumentId' | 'fileGateway' | 'documentVersion' | 'document'
  | 'completedGeneration' | 'cancelRequestCount'> & { readonly activeSketchId: string };

export type ConnectionEndpoint = { readonly owner: SelectionOwner } & (
  | { readonly kind: 'point'; readonly sketchId: string; readonly pointId: string }
  | { readonly kind: 'vertex'; readonly originalReference: SubShapeRef; readonly matchedReference: SubShapeRef }
);

export interface ConnectionSelection {
  readonly selection: readonly string[];
  readonly endpoints: ReadonlyMap<string, ConnectionEndpoint>;
}

/** Uses the same completed result snapshot as ordinary sketches without math measurements. */
export function hasCurrentConnectionGeometry(state: AppState): boolean {
  const snapshot = state.mathGeometryResult;
  return activeDocumentKind(state) === 'part' && !state.isComputing
    && state.requestedGeneration === state.completedGeneration && state.lastOutcome === 'success'
    && !state.recomputeCancelled && state.timelineIndex === null && snapshot !== null
    && snapshot.generation === state.completedGeneration && snapshot.document.id === state.document.id
    && snapshot.document.activeSketchId === state.sketch.id && state.document.activeSketchId === state.sketch.id
    && state.document.sketches.find(sketch => sketch.id === state.sketch.id) === state.sketch
    && !affectsShape(snapshot.document, state.document);
}

function ownerOf(state: AppState): SelectionOwner {
  return { activeDocumentId: state.activeDocumentId, fileGateway: state.fileGateway,
    documentVersion: state.documentVersion, document: state.document, activeSketchId: state.sketch.id,
    completedGeneration: state.completedGeneration, cancelRequestCount: state.cancelRequestCount };
}

export function isCurrentConnectionEndpoint(state: AppState, endpoint: ConnectionEndpoint): boolean {
  const owner = endpoint.owner;
  return owner.activeDocumentId === state.activeDocumentId && owner.fileGateway === state.fileGateway
    && owner.documentVersion === state.documentVersion && owner.activeSketchId === state.sketch.id
    && owner.cancelRequestCount === state.cancelRequestCount && !affectsShape(owner.document, state.document)
    && (endpoint.kind !== 'vertex' || owner.completedGeneration === state.completedGeneration);
}

function captureEndpoint(state: AppState, id: string, source: SelectionSource): ConnectionEndpoint | null {
  const sketchId = source.kind === 'sketch' ? source.sketchId : state.sketch.id;
  const sketch = state.document.sketches.find(value => value.id === sketchId);
  if (source.kind !== 'references' && sketch?.features.some(feature => feature.id === id && feature.kind === 'point')) {
    return { kind: 'point', pointId: id, sketchId, owner: ownerOf(state) };
  }
  const parsed = parseSubShapeId(id);
  if (source.kind === 'sketch' || parsed?.kind !== 'vertex' || !hasCurrentConnectionGeometry(state)) return null;
  const supplied = source.kind === 'references' ? source.references.find(value => value.elementId === id) : undefined;
  const reference = source.kind === 'references' ? supplied?.originalReference ?? null
    : subShapeRefOf(subShapeBodiesOf(state.bodies), id);
  if (reference === null || reference.fingerprint.kind !== 'vertex') return null;
  const bodies = state.bodies.filter(body => body.featureId === reference.bodyFeatureId && body.isValid);
  if (bodies.length !== 1) return null;
  const result = resolveSubShapeReference(bodies[0], reference);
  if (result.status !== 'matched' || result.match.geometry.kind !== 'vertex'
    || result.match.reference.index !== parsed.index || result.match.reference.bodyFeatureId !== parsed.bodyFeatureId) return null;
  return { kind: 'vertex', originalReference: reference, matchedReference: result.match.reference, owner: ownerOf(state) };
}

/** Only an actual source can certify a new selection. Existing entries never acquire a new owner. */
export function captureConnectionSelection(state: AppState, selection: readonly string[], source?: SelectionSource,
  preserveExisting = false): ConnectionSelection {
  const previous = preserveExisting && state.connectionSelection?.selection === state.selection
    ? state.connectionSelection.endpoints : undefined;
  // A plain click on a draggable sketch point starts a drag before it selects the point.
  // That drag is an actual viewport hit, even though its setSelection call has no source.
  // Only the single, untouched point under that drag can inherit its provenance.
  const drag = state.sketchDrag;
  const dragSource = source === undefined && selection.length === 1 && drag !== null
    && drag.field === 'at' && drag.index === null && drag.pointKey === selection[0]
    && drag.featureId === selection[0] && state.dragResolved === null && hasCurrentConnectionGeometry(state)
    ? { kind: 'sketch', sketchId: state.sketch.id } as const : undefined;
  const endpoints = new Map<string, ConnectionEndpoint>();
  for (const id of selection) {
    const previousEndpoint = previous?.get(id);
    const effectiveSource = source ?? dragSource;
    const endpoint = previousEndpoint ?? (effectiveSource === undefined ? null : captureEndpoint(state, id, effectiveSource));
    // An old raw ID without a certificate must not become fresh when another item is added.
    if (preserveExisting && state.selection.includes(id) && previousEndpoint === undefined) continue;
    if (endpoint !== null) endpoints.set(id, endpoint);
  }
  return { selection, endpoints };
}

/** Saving a set retains its selected original fingerprint, including after a shape change. */
export function selectedVertexReferences(state: AppState): ReadonlyMap<string, SubShapeRef> {
  const references = new Map<string, SubShapeRef>();
  if (state.connectionSelection?.selection !== state.selection) return references;
  for (const [id, endpoint] of state.connectionSelection.endpoints) {
    if (endpoint.kind === 'vertex' && endpoint.owner.activeDocumentId === state.activeDocumentId
      && endpoint.owner.fileGateway === state.fileGateway) references.set(id, endpoint.originalReference);
  }
  return references;
}

export type ConnectionPointPick = { readonly kind: 'hit'; readonly elementId: string }
  | { readonly kind: 'ambiguous' } | null;

/** Vertex selection mode admits real sketch point features too, with identical hover/click rules. */
export function pickConnectionPoint(state: Pick<AppState, 'sketch' | 'resolvedSketch' | 'bodies' | 'displaySettings'>,
  project: ProjectToScreen, pointer: readonly [number, number]): ConnectionPointPick {
  const candidates: { readonly elementId: string; readonly distance: number }[] = [];
  const add = (elementId: string, position: Vec3): void => {
    if (!position.every(Number.isFinite)) return;
    const screen = project(position);
    if (screen === null) return;
    const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
    if (distance <= PICK_RADIUS_PIXELS) candidates.push({ elementId, distance });
  };
  const points = new Set(state.sketch.features.filter(feature => feature.kind === 'point').map(feature => feature.id));
  for (const point of state.resolvedSketch.points) {
    if (point.id === point.featureId && points.has(point.featureId)) add(point.id, point.position);
  }
  if (state.displaySettings.selectionFilter.vertex) {
    for (const body of state.bodies) for (const vertex of body.vertices) {
      add(subShapeElementId(body.featureId, 'vertex', vertex.index), vertex.position);
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  if (candidates.length === 0) return null;
  // A half screen pixel is not a reliable way to distinguish overlapping projected points.
  if (candidates.length > 1 && candidates[1].distance - candidates[0].distance <= 0.5) return { kind: 'ambiguous' };
  return { kind: 'hit', elementId: candidates[0].elementId };
}
