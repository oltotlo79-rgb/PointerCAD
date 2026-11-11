import type { KernelBridge, SolidBody, RigidPlacement } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { activeDocument } from '../store/documentKind.js';
import type { ReferenceRepairSession } from './referenceRepair.js';
import type { RepairCandidate } from './referenceRepairCandidates.js';
import { subShapeElementId } from './subShapeSelection.js';

type Scope = NonNullable<AppState['referenceRepairBodies']>['scope'];
type Owner = NonNullable<ReturnType<NonNullable<KernelBridge['meshLedgerOwner']>>>;
export type RepairPreviewReceipt = Awaited<ReturnType<NonNullable<KernelBridge['captureCurrentMeshLedger']>>>;
export type RepairPreviewInspection = Awaited<ReturnType<NonNullable<KernelBridge['inspectSourceMeshBackings']>>>;

/** Issued metadata only. Mesh, session and borrowed scope references are weak. */
export interface ReferenceRepairPreview {
  readonly operationId: number;
  readonly documentId: string;
  readonly generation: number;
  readonly componentId: string | null;
  readonly hoverId: string;
  readonly elementId: string;
}
export interface ReferenceRepairPreviewBorrow {
  readonly body: SolidBody;
  readonly scope: Scope;
  readonly displayBodies: readonly SolidBody[];
  readonly additionalOwners: readonly Owner[];
  readonly placement: RigidPlacement | null;
}
interface IssuedPreview {
  readonly metadata: ReferenceRepairPreview;
  readonly session: WeakRef<ReferenceRepairSession>;
  readonly candidate: WeakRef<RepairCandidate>;
  readonly body: WeakRef<SolidBody>;
  readonly scope: WeakRef<Scope>;
  readonly displayBodies: WeakRef<readonly SolidBody[]>;
  readonly positions: WeakRef<Float32Array>;
  readonly normals: WeakRef<Float32Array>;
  readonly indices: WeakRef<Uint32Array>;
  readonly edges: WeakRef<Float32Array>;
  readonly byteLengths: readonly number[];
  readonly frame: WeakRef<NonNullable<SolidBody['coordinateFrame']>> | null;
  readonly origin: readonly number[];
  readonly frameError: number | undefined;
  readonly frameBudget: number | undefined;
  readonly triangleCount: number;
  readonly placement: WeakRef<RigidPlacement> | null;
  readonly placementValues: readonly number[];
  readonly current: (session: ReferenceRepairSession, state: AppState) => boolean;
}
export interface ReferenceRepairRejection { readonly reason: string; }
const repairRejections: ReferenceRepairRejection[] = [];
/** Primitive-only bounded diagnostics. No callbacks, owners, geometry or additional observations. */
export function recordReferenceRepairRejection(reason: string): null {
  try {
    if (repairRejections.length === 64) repairRejections.shift();
    repairRejections.push(Object.freeze({ reason: reason.slice(0, 120) }));
  } catch { /* Diagnostics cannot alter the original rejection result. */ }
  return null;
}
export function readReferenceRepairRejections(): readonly ReferenceRepairRejection[] {
  return Object.freeze(repairRejections.map(entry => Object.freeze({ ...entry })));
}

const issued = new WeakSet<ReferenceRepairPreview>();
let active: IssuedPreview | null = null;
let nextOperation = 0;

function borrowSource(state: AppState, session: ReferenceRepairSession, body: SolidBody): ReferenceRepairPreviewBorrow | null {
  const document = activeDocument(state);
  if (document.kind === 'part') {
    const source = state.referenceRepairBodies;
    if (source === null) return recordReferenceRepairRejection('borrow-part:1');
    if (source.document !== document.document) return recordReferenceRepairRejection('borrow-part:2');
    if (source.activeDocumentId !== state.activeDocumentId) return recordReferenceRepairRejection('borrow-part:3');
    if (source.generation !== state.requestedGeneration) return recordReferenceRepairRejection('borrow-part:4');
    if (source.generation !== state.completedGeneration) return recordReferenceRepairRejection('borrow-part:5');
    if (source.displayBodies !== state.bodies) return recordReferenceRepairRejection('borrow-part:6');
    if (!source.scope.current) return recordReferenceRepairRejection('borrow-part:7');
    if (source.scope.referenceBodyCurrent?.(body) !== true) return recordReferenceRepairRejection('borrow-part:8');
    if (!source.bodies.includes(body)) return recordReferenceRepairRejection('borrow-part:9');
    if (state.bodies.includes(body)) return recordReferenceRepairRejection('borrow-part:10');
    return { body, scope: source.scope, displayBodies: source.displayBodies, additionalOwners: [], placement: null };
  }
  if (document.kind !== 'assembly') return recordReferenceRepairRejection('borrow-mode:1');
  if (session.slot.componentId === undefined) return recordReferenceRepairRejection('borrow-mode:2');
  if (state.assemblyDragOverlay !== null) return recordReferenceRepairRejection('borrow-mode:3');
  if (state.assemblyMotionPlacements !== null) return recordReferenceRepairRejection('borrow-mode:4');
  const view = state.assemblyView, owner = view?.meshOwnership;
  const component = document.document.components.find(item => item.id === session.slot.componentId);
  const key = view?.resolved.partKeys.get(session.slot.componentId);
  const source = key === undefined ? undefined : owner?.sources.get(key);
  const placement = view?.resolved.placements.get(session.slot.componentId);
  const scope = source?.result.referenceMeshScope;
  if (component === undefined) return recordReferenceRepairRejection('borrow-assembly:1');
  if (component.suppressed) return recordReferenceRepairRejection('borrow-assembly:2');
  if (view?.sourceDocument !== document.document) return recordReferenceRepairRejection('borrow-assembly:3');
  if (owner === undefined) return recordReferenceRepairRejection('borrow-assembly:4');
  if (owner.document !== document.document) return recordReferenceRepairRejection('borrow-assembly:5');
  if (owner.library !== state.assemblyLibrary) return recordReferenceRepairRejection('borrow-assembly:6');
  if (owner.activeDocumentId !== state.activeDocumentId) return recordReferenceRepairRejection('borrow-assembly:7');
  if (owner.documentVersion !== state.documentVersion) return recordReferenceRepairRejection('borrow-assembly:8');
  if (owner.generation !== state.requestedGeneration) return recordReferenceRepairRejection('borrow-assembly:9');
  if (owner.generation !== state.completedGeneration) return recordReferenceRepairRejection('borrow-assembly:10');
  if (!owner.publicationCurrent()) return recordReferenceRepairRejection('borrow-assembly:11');
  if (source === undefined) return recordReferenceRepairRejection('borrow-assembly:12');
  if (!source.current()) return recordReferenceRepairRejection('borrow-assembly:13');
  if (source.result.cancelled) return recordReferenceRepairRejection('borrow-assembly:14');
  if (source.result.errors.some(error => error.featureId === body.featureId)) return recordReferenceRepairRejection('borrow-assembly:15');
  if (scope === undefined) return recordReferenceRepairRejection('borrow-assembly:16');
  if (!scope.current) return recordReferenceRepairRejection('borrow-assembly:17');
  if (scope.document !== source.document) return recordReferenceRepairRejection('borrow-assembly:18');
  if (scope.context.generation !== source.result.generation) return recordReferenceRepairRejection('borrow-assembly:19');
  if (scope.referenceBodyCurrent?.(body) !== true) return recordReferenceRepairRejection('borrow-assembly:20');
  if (!source.result.referenceBodies?.includes(body)) return recordReferenceRepairRejection('borrow-assembly:21');
  if (placement === undefined) return recordReferenceRepairRejection('borrow-assembly:22');
  if (component.visible && source.bodies.includes(body)) return recordReferenceRepairRejection('borrow-assembly:23');
  const additionalOwners: Owner[] = [];
  for (const [partKey, member] of owner.sources) {
    if (!member.current()) return recordReferenceRepairRejection('borrow-member-current');
    if (owner.bodies.get(partKey) !== member.bodies) return recordReferenceRepairRejection('borrow-member-bodies');
    if (member.displayOwner !== null) additionalOwners.push(member.displayOwner);
    additionalOwners.push(...member.hiddenOwners);
  }
  return { body, scope, displayBodies: source.bodies, additionalOwners, placement };
}

export function beginReferenceRepairPreview(session: ReferenceRepairSession, candidate: RepairCandidate,
  hoverId: string, state: AppState, current: IssuedPreview['current']): void {
  active = null;
  if (!current(session, state)) { recordReferenceRepairRejection('begin-current'); return; }
  if (!candidate.selectable) { recordReferenceRepairRejection('begin-selectable'); return; }
  if (!session.candidates.includes(candidate)) { recordReferenceRepairRejection('begin-membership'); return; }
  const borrowed = borrowSource(state, session, candidate.body);
  if (borrowed === null) return;
  const body = candidate.body, mesh = body.mesh, frame = body.coordinateFrame;
  const metadata: ReferenceRepairPreview = Object.freeze({ operationId: ++nextOperation,
    documentId: state.activeDocumentId, generation: state.completedGeneration,
    componentId: session.slot.componentId ?? null, hoverId,
    elementId: subShapeElementId(candidate.reference.bodyFeatureId, candidate.reference.fingerprint.kind, candidate.reference.index) });
  issued.add(metadata);
  active = { metadata, session: new WeakRef(session), candidate: new WeakRef(candidate), body: new WeakRef(body),
    scope: new WeakRef(borrowed.scope), displayBodies: new WeakRef(borrowed.displayBodies),
    positions: new WeakRef(mesh.positions), normals: new WeakRef(mesh.normals), indices: new WeakRef(mesh.indices),
    edges: new WeakRef(mesh.edgePositions), byteLengths: [mesh.positions.byteLength, mesh.normals.byteLength,
      mesh.indices.byteLength, mesh.edgePositions.byteLength], frame: frame === undefined ? null : new WeakRef(frame),
    origin: frame?.origin.slice() ?? [], frameError: frame?.maximumFloat32ErrorMm,
    frameBudget: frame?.maximumLiveMeshBytes, triangleCount: mesh.triangleCount,
    placement: borrowed.placement === null ? null : new WeakRef(borrowed.placement),
    placementValues: borrowed.placement === null ? [] : [...borrowed.placement.position, ...borrowed.placement.rotation], current };
}

export function clearReferenceRepairPreview(session: ReferenceRepairSession): void {
  if (active?.session.deref() === session) active = null;
}

export function borrowReferenceRepairPreview(preview: ReferenceRepairPreview, state: AppState): ReferenceRepairPreviewBorrow | null {
  const entry = active;
  if (!issued.has(preview) || entry?.metadata !== preview || preview.documentId !== state.activeDocumentId
    || preview.generation !== state.completedGeneration || preview.generation !== state.requestedGeneration
    || state.hoveredElementId !== preview.hoverId || state.isComputing || state.recomputeCancelled) return null;
  const session = entry.session.deref(), candidate = entry.candidate.deref(), body = entry.body.deref();
  if (session === undefined || candidate === undefined || body === undefined || candidate.body !== body
    || !entry.current(session, state) || !session.candidates.includes(candidate)) return null;
  const mesh = body.mesh, frame = body.coordinateFrame;
  if (mesh.positions !== entry.positions.deref() || mesh.normals !== entry.normals.deref()
    || mesh.indices !== entry.indices.deref() || mesh.edgePositions !== entry.edges.deref()
    || mesh.triangleCount !== entry.triangleCount || (frame ?? null) !== (entry.frame?.deref() ?? null)
    || frame?.maximumFloat32ErrorMm !== entry.frameError || frame?.maximumLiveMeshBytes !== entry.frameBudget
    || (frame !== undefined && !frame.origin.every((value, index) => value === entry.origin[index]))
    || [mesh.positions, mesh.normals, mesh.indices, mesh.edgePositions].some((array, index) => array.byteLength !== entry.byteLengths[index])) return null;
  const borrowed = borrowSource(state, session, body);
  return borrowed !== null && borrowed.scope === entry.scope.deref() && borrowed.displayBodies === entry.displayBodies.deref()
    && borrowed.placement === (entry.placement?.deref() ?? null)
    && (borrowed.placement === null || [...borrowed.placement.position, ...borrowed.placement.rotation]
      .every((value, index) => Number.isFinite(value) && value === entry.placementValues[index]))
    ? borrowed : null;
}

export function currentReferenceRepairPreview(state: AppState): ReferenceRepairPreview | null {
  const metadata = active?.metadata;
  return metadata !== undefined && borrowReferenceRepairPreview(metadata, state) !== null ? metadata : null;
}
