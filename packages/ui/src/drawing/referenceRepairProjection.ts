import { canonicalDrawingSourceText, createSubShapeReference, drawingTargetFromProjection,
  resolveSubShapeReference, type SubShapeRef } from '@pointercad/model';
import { resolveStyle, type DrawingRenderElement } from '@pointercad/drawing';
import type { AppState } from '../store/appState.js';
import { activeDocument } from '../store/documentKind.js';

const PREFIX = 'reference-repair-drawing:';
const MAX_DESCRIPTOR_LENGTH = 16_384;
let identities = new WeakMap<object, string>();
let activeDescriptorId: string | null = null;
let identityCount = 0;
let nextIdentity = 0n;
function identity(value: object): string {
  const previous = identities.get(value);
  if (previous !== undefined) return previous;
  const result = (++nextIdentity).toString();
  identities.set(value, result);
  identityCount++;
  return result;
}

interface DrawingRepairHoverDescriptor {
  readonly version: 1;
  readonly document: string;
  readonly documentId: string;
  readonly documentVersion: number;
  readonly resolution: string;
  readonly source: string;
  readonly body: string;
  readonly session: string;
  readonly sourceRef: string;
  readonly componentId: string | null;
  readonly bodyId: string;
  readonly featureId: string;
  readonly kind: 'edge' | 'face' | 'vertex';
  readonly index: number;
  readonly semanticKey: string;
}
const referenceKey = (reference: SubShapeRef): string => canonicalDrawingSourceText(reference.origin === undefined
  ? reference : { bodyFeatureId: reference.bodyFeatureId, kind: reference.fingerprint.kind, origin: reference.origin });

/** Metadata only; WeakMap keys do not retain documents, bodies or repair sessions. */
export function drawingRepairHoverId(state: AppState, slot: { readonly sourceRef?: string; readonly componentId?: string },
  reference: SubShapeRef, sessionOwner: object): string | null {
  const active = activeDocument(state), source = state.drawingSourceResolution, resolution = state.drawingResolution;
  if (active.kind !== 'drawing' || state.drawingBusy || source === null || resolution?.ok !== true
    || resolution.document !== active.document || resolution.projection.cancelled || slot.sourceRef === undefined) return null;
  const matches = (source.dimensionInstances ?? []).filter(instance => instance.sourceRef === slot.sourceRef
    && instance.componentId === slot.componentId && instance.body.featureId === reference.bodyFeatureId && instance.body.isValid);
  if (matches.length !== 1) return null;
  const instance = matches[0], resolved = resolveSubShapeReference(instance.body, reference);
  if (resolved.status !== 'matched') return null;
  const current = createSubShapeReference(instance.body, reference.fingerprint.kind, resolved.match.reference.index);
  if (current === null) return null;
  const previous = { identities, activeDescriptorId, identityCount };
  identities = new WeakMap<object, string>(); identityCount = 0;
  const descriptor: DrawingRepairHoverDescriptor = { version: 1, document: identity(active.document),
    documentId: state.activeDocumentId, documentVersion: state.documentVersion, resolution: identity(resolution),
    source: identity(source), body: identity(instance.body), session: identity(sessionOwner), sourceRef: slot.sourceRef,
    componentId: slot.componentId ?? null, bodyId: instance.bodyId, featureId: instance.body.featureId,
    kind: current.fingerprint.kind, index: current.index, semanticKey: referenceKey(current) };
  const id = PREFIX + JSON.stringify(descriptor);
  if (id.length > MAX_DESCRIPTOR_LENGTH) {
    identities = previous.identities; activeDescriptorId = previous.activeDescriptorId; identityCount = previous.identityCount;
    return null;
  }
  activeDescriptorId = id;
  return id;
}

/** The current descriptor has at most five weak identity keys and no retained mesh. */
export function drawingRepairDescriptorObservation(): { readonly active: boolean; readonly identityCount: number } {
  return { active: activeDescriptorId !== null, identityCount };
}
export function clearDrawingRepairDescriptor(id: string): void {
  if (activeDescriptorId !== id) return;
  identities = new WeakMap<object, string>(); identityCount = 0; activeDescriptorId = null;
}

function isDescriptor(value: unknown): value is DrawingRepairHoverDescriptor {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    const strings = ['document', 'documentId', 'resolution', 'source', 'body', 'session', 'sourceRef', 'bodyId', 'featureId', 'semanticKey'];
    if (strings.some(key => typeof data[key] !== 'string' || data[key] === '') || data.version !== 1
      || typeof data.documentVersion !== 'number' || !Number.isSafeInteger(data.documentVersion) || data.documentVersion < 0
      || typeof data.index !== 'number' || !Number.isSafeInteger(data.index) || data.index < 0
      || data.componentId !== null && typeof data.componentId !== 'string'
      || data.kind !== 'edge' && data.kind !== 'face' && data.kind !== 'vertex') return false;
    return true;
}
function parse(id: string): DrawingRepairHoverDescriptor | null {
  if (!id.startsWith(PREFIX) || id.length > MAX_DESCRIPTOR_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(id.slice(PREFIX.length));
    return isDescriptor(value) ? value : null;
  } catch { return null; }
}

export type DrawingRepairProjectionReading =
  | { readonly status: 'idle'; readonly elements: readonly DrawingRenderElement[] }
  | { readonly status: 'current'; readonly elements: readonly DrawingRenderElement[] }
  | { readonly status: 'unavailable'; readonly reason: 'malformed-descriptor' | 'stale-owner' | 'source-not-projected'
      | 'ambiguous-body' | 'semantic-unresolved' | 'face-provenance-unproved' | 'vertex-provenance-unproved'
      | 'no-certified-projection'; readonly elements: readonly DrawingRenderElement[] };

/** Exact current provenance only. Neither distance nor component-wide selection is a fallback. */
export function drawingRepairProjection(state: AppState, hoverId: string | null): DrawingRepairProjectionReading {
  if (hoverId === null || !hoverId.startsWith(PREFIX)) return { status: 'idle', elements: [] };
  const unavailable = (reason: Extract<DrawingRepairProjectionReading, { status: 'unavailable' }>['reason']): DrawingRepairProjectionReading =>
    ({ status: 'unavailable', reason, elements: [] });
  const descriptor = parse(hoverId);
  if (descriptor === null) return unavailable('malformed-descriptor');
  if (hoverId !== activeDescriptorId) return unavailable('stale-owner');
  const active = activeDocument(state), source = state.drawingSourceResolution, resolution = state.drawingResolution;
  if (active.kind !== 'drawing' || state.drawingBusy || source === null || resolution?.ok !== true
    || resolution.document !== active.document || resolution.projection.cancelled
    || identities.get(active.document) !== descriptor.document || state.activeDocumentId !== descriptor.documentId
    || state.documentVersion !== descriptor.documentVersion || identities.get(resolution) !== descriptor.resolution
    || identities.get(source) !== descriptor.source) return unavailable('stale-owner');
  // Projection views originate from the drawing's actual source; an unrelated instance cannot reuse them.
  if (descriptor.sourceRef !== active.document.source.sourceRef) return unavailable('source-not-projected');
  const instances = source.dimensionInstances ?? [];
  const matches = instances.filter(instance => instance.sourceRef === descriptor.sourceRef
    && (instance.componentId ?? null) === descriptor.componentId && instance.bodyId === descriptor.bodyId
    && instance.body.featureId === descriptor.featureId && instance.body.isValid);
  if (matches.length !== 1) return unavailable('ambiguous-body');
  const instance = matches[0];
  if (identities.get(instance.body) !== descriptor.body) return unavailable('stale-owner');
  const current = createSubShapeReference(instance.body, descriptor.kind, descriptor.index);
  if (current === null || referenceKey(current) !== descriptor.semanticKey
    || resolveSubShapeReference(instance.body, current).status !== 'matched') return unavailable('semantic-unresolved');
  if (descriptor.kind === 'face') return unavailable('face-provenance-unproved');
  if (descriptor.kind === 'vertex') return unavailable('vertex-provenance-unproved');
  const elements: DrawingRenderElement[] = [];
  for (const projected of resolution.projection.views) {
    const view = active.document.views.find(item => item.id === projected.viewId);
    if (view === undefined || resolveStyle(view, active.document.layers)?.visible !== true) continue;
    const certified = [...projected.visible, ...(view.showHidden ? projected.hidden : [])].filter(item => {
      const provenance = item.provenance;
      if (provenance.bodyId !== descriptor.bodyId || (provenance.occurrenceId ?? null) !== descriptor.componentId
        || provenance.sourceRef !== undefined && provenance.sourceRef !== descriptor.sourceRef) return false;
      const target = drawingTargetFromProjection(item, projected.viewId, descriptor.sourceRef, instances);
      if (target?.kind !== 'subShape' || target.ref.fingerprint.kind !== 'edge') return false;
      const resolved = resolveSubShapeReference(instance.body, target.ref);
      return resolved.status === 'matched' && resolved.match.reference.index === descriptor.index
        && referenceKey(target.ref) === descriptor.semanticKey;
    });
    if (certified.length === 0) continue;
    elements.push({ ownerId: `${PREFIX}${descriptor.session}:${projected.viewId}`, viewId: projected.viewId,
      layerId: view.layerId, style: { color: '#f59e0b', lineType: 'solid', lineWidth: 0.5 },
      curves: certified.map(item => item.curve) });
  }
  return elements.length === 0 ? unavailable('no-certified-projection') : { status: 'current', elements };
}
