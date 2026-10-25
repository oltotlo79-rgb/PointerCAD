import type { AssemblyDocument, AssemblyKernelBridge, EmbeddedPartAttachments,
  PartDocument, PartLibrary, PartRecomputeResult, SolidBody } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';
import type { MeshBodyLayout } from '../store/recomputeSlice.js';

type LedgerOwner = NonNullable<ReturnType<NonNullable<AssemblyKernelBridge['meshLedgerOwner']>>>;
type LedgerReceipt = Awaited<ReturnType<NonNullable<AssemblyKernelBridge['captureCurrentMeshLedger']>>>;
type BackingInspection = Awaited<ReturnType<NonNullable<AssemblyKernelBridge['inspectSourceMeshBackings']>>>;

/** Actual source result; the Assembly request never relabels a cache-hit source generation. */
export interface AssemblySourceMeshOwner {
  readonly document: PartDocument;
  readonly attachments: EmbeddedPartAttachments | undefined;
  readonly result: PartRecomputeResult;
  readonly bodies: readonly SolidBody[];
  readonly layouts: readonly MeshBodyLayout[];
  readonly displayOwner: LedgerOwner | null;
  readonly hiddenOwners: readonly LedgerOwner[];
  readonly current: () => boolean;
}

/** Nonstored publication evidence; never part of AssemblySnapshot or saved documents. */
export interface AssemblyMeshOwnership {
  readonly document: AssemblyDocument;
  readonly library: PartLibrary;
  readonly activeDocumentId: string;
  readonly documentVersion: number;
  readonly generation: number;
  readonly outcome: AppState['lastOutcome'];
  readonly timelineIndex: AppState['timelineIndex'];
  readonly cancelRequestCount: number;
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
  readonly sources: ReadonlyMap<string, AssemblySourceMeshOwner>;
  readonly receipt: LedgerReceipt;
  readonly backingInspection: BackingInspection;
  readonly backingInspectionCurrent: () => boolean;
  readonly uiSnapshot: { readonly epoch: number; readonly buffers: readonly { readonly buffer: WeakRef<ArrayBuffer>; readonly bytes: number }[] };
  readonly receiptCurrent: () => boolean;
  readonly publicationCurrent: () => boolean;
  /** Producer-owned exact-publication refresh; no Doc/version/generation/Undo change or borrowed release. */
  readonly refreshOwnership?: (expected: AssemblyMeshOwnership) => Promise<AssemblyMeshOwnership | null>;
}

export interface AssemblyMeshAdmission {
  readonly bundle: AssemblyGeometryBundle;
  readonly ownership: AssemblyMeshOwnership;
  readonly state: AppState;
}

function count(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }

function layoutsCurrent(source: AssemblySourceMeshOwner): boolean {
  if (source.bodies !== source.result.bodies || source.bodies.length !== source.layouts.length) return false;
  return source.bodies.every((body, index) => {
    const layout = source.layouts[index];
    if (layout === undefined) return false;
    const mesh = body.mesh, frame = body.coordinateFrame;
    return body === layout.body && mesh === layout.mesh && frame === layout.frame
      && mesh.positions === layout.positions && mesh.normals === layout.normals && mesh.indices === layout.indices
      && mesh.edgePositions === layout.edges && mesh.triangleCount === layout.triangleCount
      && frame?.maximumFloat32ErrorMm === layout.error && frame?.maximumLiveMeshBytes === layout.budget
      && mesh.positions.byteLength === layout.byteLengths[0] && mesh.normals.byteLength === layout.byteLengths[1]
      && mesh.indices.byteLength === layout.byteLengths[2] && mesh.edgePositions.byteLength === layout.byteLengths[3]
      && (frame === undefined || frame.origin.every((value, at) => value === layout.origin[at]));
  });
}

/**
 * receipt.owners indexed by dispatchId, built once per frozen issued owner list (a bridge receipt never changes).
 * sourceCurrent used to scan the whole list for every required owner: with one display owner per distinct part
 * definition, one admission check was O(sources x owners) and the assembly layer repeats it on every allocation, so a
 * 1,000-definition publication blocked the page for minutes (EX12 W02). The compared fields and the result are the same;
 * an unfrozen list is indexed again on every call because it could change after a check.
 */
const issuedOwnersByDispatch = new WeakMap<readonly LedgerOwner[], ReadonlyMap<string, readonly LedgerOwner[]>>();
function issuedOwnersOf(owners: readonly LedgerOwner[]): ReadonlyMap<string, readonly LedgerOwner[]> {
  const cached = issuedOwnersByDispatch.get(owners);
  if (cached !== undefined) return cached;
  const byDispatch = new Map<string, LedgerOwner[]>();
  for (const issued of owners) {
    const same = byDispatch.get(issued.dispatchId);
    if (same === undefined) byDispatch.set(issued.dispatchId, [issued]); else same.push(issued);
  }
  if (Object.isFrozen(owners)) issuedOwnersByDispatch.set(owners, byDispatch);
  return byDispatch;
}

function sourceCurrent(source: AssemblySourceMeshOwner, receipt: LedgerReceipt): boolean {
  if (!source.current() || !layoutsCurrent(source) || source.result.cancelled || source.result.errors.length > 0) return false;
  const display = source.displayOwner;
  if (source.bodies.length > 0 && (display === null || display.kind !== 'display'
    || display.generation !== source.result.generation)) return false;
  const required = display === null ? source.hiddenOwners : [display, ...source.hiddenOwners];
  if (receipt.status !== 'known' || required.some(owner => !(issuedOwnersOf(receipt.owners).get(owner.dispatchId) ?? []).some(issued =>
    issued.dispatchId === owner.dispatchId && issued.partId === owner.partId
    && issued.generation === owner.generation && issued.kind === owner.kind
    && issued.steps.length === owner.steps.length && issued.steps.every((step, index) =>
      step.id === owner.steps[index]?.id && step.key === owner.steps[index]?.key)))) return false;
  if (!source.bodies.some(body => body.coordinateFrame !== undefined)) return true;
  const accounting = source.result.meshJsAccounting;
  if (accounting === undefined || accounting.reading.status !== 'known'
    || accounting.documentId !== source.document.id || accounting.partId !== display?.partId
    || accounting.generation !== source.result.generation) return false;
  const reading = accounting.reading;
  // The original frame is checked against its original issued source receipt.
  // The fresh global limit can be smaller; allocation admission uses that fresh limit below.
  return source.bodies.every(body => {
    const frame = body.coordinateFrame;
    return frame !== undefined && frame.space === 'local' && frame.origin.length === 3
      && frame.origin.every(Number.isFinite) && Number.isFinite(frame.maximumFloat32ErrorMm)
      && frame.maximumFloat32ErrorMm > 0 && frame.maximumLiveMeshBytes === reading.limitBytes;
  });
}

/** Publication identity only: stale receipt/inspection never makes display admission valid.
 * The producer must still acquire fresh issued evidence and recheck this boundary after each await. */
export function currentAssemblyMeshPublication(owner: AssemblyMeshOwnership, state: AppState): boolean {
  const view = state.assemblyView;
  if (view === null || view.meshOwnership !== owner || state.assembly !== owner.document
    || view.sourceDocument !== owner.document || state.assemblyLibrary !== owner.library
    || state.activeDocumentId !== owner.activeDocumentId || state.documentVersion !== owner.documentVersion
    || state.requestedGeneration !== owner.generation || state.completedGeneration !== owner.generation
    || state.lastOutcome !== owner.outcome || state.timelineIndex !== owner.timelineIndex
    || state.cancelRequestCount !== owner.cancelRequestCount || state.recomputeCancelled
    || state.drawing !== null || view.bodies !== owner.bodies || !owner.publicationCurrent()) return false;
  for (const [key, source] of owner.sources) {
    if (owner.bodies.get(key) !== source.bodies || !source.current() || !layoutsCurrent(source)
      || source.result.cancelled || source.result.errors.length > 0) return false;
  }
  for (const key of owner.bodies.keys()) if (!owner.sources.has(key)) return false;
  return true;
}

export function currentAssemblyMeshAdmission(admission: AssemblyMeshAdmission, state: AppState): boolean {
  const owner = admission.ownership, receipt = owner.receipt;
  if (!currentAssemblyMeshPublication(owner, state)
    || admission.bundle.sourceDocument !== owner.document || admission.bundle.sourceBodies !== owner.bodies
    || !owner.receiptCurrent() || receipt.status !== 'known'
    || owner.backingInspection.status !== 'known' || !owner.backingInspectionCurrent()) return false;
  if (!Number.isSafeInteger(receipt.limitBytes) || receipt.limitBytes <= 0 || receipt.limitBytes > 512 * 1024 * 1024
    || !count(receipt.admittedBoundBytes) || receipt.admittedBoundBytes > receipt.limitBytes
    || !count(receipt.workerRetainedBackingBytes) || !count(receipt.hostRetainedBackingBytes)
    || !count(receipt.pendingCloneReservedBytes)
    || receipt.admittedBoundBytes !== receipt.workerRetainedBackingBytes + receipt.hostRetainedBackingBytes + receipt.pendingCloneReservedBytes
    || receipt.coverage !== 'registered-solid-mesh-backings-only') return false;
  // Nonvisible Parts still own global retained resources and exact current source documents.
  for (const [key, source] of owner.sources) {
    if (owner.bodies.get(key) !== source.bodies || !sourceCurrent(source, receipt)) return false;
  }
  for (const key of owner.bodies.keys()) if (!owner.sources.has(key)) return false;
  // A mate failure does not invalidate successful source Parts; publicationCurrent binds the actual outcome.
  return admission.bundle.parts.every(part => {
    const source = owner.sources.get(part.partKey);
    return source !== undefined && owner.bodies.get(part.partKey) === part.bodies
      && source.bodies === part.bodies && sourceCurrent(source, receipt);
  });
}

export function captureAssemblyMeshAdmission(bundle: AssemblyGeometryBundle, state: AppState): AssemblyMeshAdmission | null {
  const ownership = state.assemblyView?.meshOwnership;
  if (ownership === undefined) return null;
  const admission = Object.freeze({ bundle, ownership, state });
  return currentAssemblyMeshAdmission(admission, state) ? admission : null;
}

/** Reads bound and real limit from the same issued fresh receipt; UI copies are added by their owner. */
export function assemblyMeshBudget(admission: AssemblyMeshAdmission, state: AppState):
  { readonly limitBytes: number; readonly baselineBytes: number; readonly sourceUiBackings: ReadonlySet<ArrayBufferLike> } | null {
  assemblyUiBackings.retryRegistration();
  if (!assemblyUiBackings.known()) return null;
  if (!currentAssemblyMeshAdmission(admission, state) || admission.ownership.receipt.status !== 'known') return null;
  const owner = admission.ownership, receipt = owner.receipt;
  if (receipt.status !== 'known' || owner.backingInspection.status !== 'known') return null;
  const knownInputs = new Set<ArrayBufferLike>();
  for (const item of owner.uiSnapshot.buffers) {
    const buffer = item.buffer.deref();
    if (buffer !== undefined) {
      if (buffer.byteLength !== item.bytes) return null;
      knownInputs.add(buffer);
    }
  }
  // An older uninspected backing is unknown. New constructor-returned buffers are
  // disjoint from the unchanged Source snapshot; managed Source reentry invalidates its receipt.
  if (assemblyUiBackings.buffers().some(buffer => !knownInputs.has(buffer)
    && !assemblyUiBackings.allocatedAfter(buffer, owner.uiSnapshot.epoch))) return null;
  const sourceUiBackings = new Set<ArrayBufferLike>();
  for (const reference of owner.backingInspection.sameSourceBackings) {
    const buffer = reference.deref(); if (buffer !== undefined) sourceUiBackings.add(buffer);
  }
  return { limitBytes: receipt.limitBytes, baselineBytes: receipt.admittedBoundBytes, sourceUiBackings };
}

/** UI-created backings only. Worker/source arrays are borrowed and must never be registered here.
 * Retirement releases an owner's reservation, not another borrower's live JS backing.
 * Weak liveness is a registered-backing bound, not a native/GPU/whole-process reading. */
export class AssemblyUiBackingLedger {
  private readonly identities = new WeakMap<ArrayBufferLike, number>();
  private readonly backings = new Map<number, WeakRef<ArrayBufferLike>>();
  private readonly reservations = new Map<object, number>();
  private readonly unregistered = new Set<ArrayBufferLike>();
  private readonly allocatedAt = new WeakMap<ArrayBufferLike, number>();
  private nextIdentity = 0;
  private revision = 0;

  epoch(): number { return this.revision; }
  known(): boolean { return this.unregistered.size === 0; }
  allocatedAfter(buffer: ArrayBufferLike, epoch: number): boolean { return (this.allocatedAt.get(buffer) ?? -1) > epoch; }

  retainUnregistered(buffer: ArrayBufferLike): void { this.unregistered.add(buffer); this.revision += 1; }

  retryRegistration(): void {
    for (const buffer of this.unregistered) {
      try { this.adopt([buffer]); this.unregistered.delete(buffer); this.revision += 1; }
      catch { /* Exact unregistered backing remains strongly owned and unknown. */ }
    }
  }

  allocated(buffer: ArrayBufferLike): void {
    this.retainUnregistered(buffer);
    if (!this.allocatedAt.has(buffer)) this.allocatedAt.set(buffer, this.revision);
    this.adopt([buffer]);
    this.unregistered.delete(buffer); this.revision += 1;
  }

  buffers(): readonly ArrayBufferLike[] {
    const result: ArrayBufferLike[] = [];
    for (const [id, reference] of this.backings) {
      const buffer = reference.deref();
      if (buffer === undefined) { this.backings.delete(id); this.revision += 1; }
      else result.push(buffer);
    }
    return result;
  }

  bytes(): number { return this.buffers().reduce((sum, buffer) => sum + buffer.byteLength, 0); }

  pending(except?: object): number {
    let bytes = 0;
    for (const [owner, reserved] of this.reservations) if (owner !== except) bytes += reserved;
    return bytes;
  }

  /** Reserve before allocating. baseline and limit must come from one current issued receipt. */
  reserve(owner: object, bytes: number, baseline: number, limit: number, sourceBackings: ReadonlySet<ArrayBufferLike> = new Set()): void {
    this.retryRegistration();
    if (!this.known()) throw new Error('Actual display backing registration is unknown');
    const live = this.buffers(), overlap = live.filter(buffer => sourceBackings.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0);
    const total = baseline + live.filter(buffer => !sourceBackings.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0)
      + this.pending(owner) + bytes;
    if (![bytes, baseline, limit, total].every(Number.isSafeInteger) || bytes < 0 || baseline < 0
      || limit <= 0 || overlap > baseline || total > limit) throw new RangeError('Assembly UI backing reservation exceeded');
    this.reservations.set(owner, bytes); this.revision += 1;
  }

  /** Register each actual newly allocated backing before publishing it or releasing its reservation. */
  adopt(buffers: Iterable<ArrayBufferLike>): void {
    for (const buffer of buffers) {
      if (this.identities.has(buffer)) continue;
      const id = ++this.nextIdentity;
      const weak = new WeakRef(buffer);
      this.identities.set(buffer, id); this.backings.set(id, weak); this.revision += 1;
    }
  }

  retire(owner: object): void {
    if (this.reservations.delete(owner)) this.revision += 1;
    // No backing deletion: another Scene, a failed disposer, or an external borrower may still hold it.
  }
}

/** Every Scene and Assembly layer uses this identity union; test fixtures use separate real instances. */
export const assemblyUiBackings = new AssemblyUiBackingLedger();
