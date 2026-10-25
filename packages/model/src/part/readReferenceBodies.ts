import type { KernelBridge, SolidBody, MeshLedgerOwner, CurrentMeshLedgerReceipt } from '../kernelBridge.js';
import type { ReferenceMeshLeaseOptions, SourceMeshBackingInspection } from '../kernelBridge/bridgeContracts.js';
import type { ResolvedSolidStep } from './resolvePart.js';

export type ReferenceBodyMissingReason = 'deleted' | 'suppressed' | 'unresolved-step' | 'failed' | 'read-failed'
  | 'unavailable' | 'unsupported' | 'invalid-body' | 'ambiguous-body';
type CachedReferenceBody = { readonly body: SolidBody } | { readonly reason: ReferenceBodyMissingReason };

/** Lives inside one recomputation only; never carries a previous generation's geometry. */
export type ReferenceBodyReads = Map<string, CachedReferenceBody>;
/** One actual recomputation's hidden-read owner set. Logical close never asserts host backing collection. */
interface ReferenceBodyClaim {
  readonly owner: MeshLedgerOwner;
  readonly featureId: string;
  readonly mesh: WeakRef<object>;
  readonly arrays: readonly WeakRef<object>[];
  readonly backings: readonly WeakRef<ArrayBufferLike>[];
  readonly byteLengths: readonly number[];
  readonly frame: WeakRef<object> | null;
  readonly origin: readonly number[];
  readonly triangleCount: number;
  readonly error: number | undefined;
  readonly budget: number | undefined;
}

export class ReferenceMeshScope {
  readonly reads: ReferenceBodyReads = new Map();
  private readonly held = new Map<string, MeshLedgerOwner>();
  private readonly bodyClaims = new WeakMap<SolidBody, ReferenceBodyClaim>();
  private readonly releaseAttempts = new Map<string, number>();
  private readonly issuedReceipts = new WeakSet<CurrentMeshLedgerReceipt>();
  private closed = false;
  private unproved = false;
  private closing: Promise<boolean> | null = null;
  constructor(readonly document: object, readonly context: ReferenceMeshLeaseOptions,
    private readonly bridge: Pick<KernelBridge, 'meshLedgerOwner' | 'captureCurrentMeshLedger' | 'currentMeshLedgerReceipt' | 'releaseReferenceMeshLease' | 'inspectSourceMeshBackings' | 'currentSourceMeshBackingInspection'>) {
    this.unproved = bridge.meshLedgerOwner === undefined || bridge.captureCurrentMeshLedger === undefined
      || bridge.currentMeshLedgerReceipt === undefined || bridge.releaseReferenceMeshLease === undefined;
  }
  get readsClosed(): boolean { return this.closed; }
  get current(): boolean { return !this.closed && !this.unproved; }
  get owners(): readonly MeshLedgerOwner[] { return Object.freeze([...this.held.values()]); }
  async register(bodies: readonly SolidBody[]): Promise<void> {
    const owner = this.bridge.meshLedgerOwner?.(bodies);
    if (owner === undefined || owner === null || owner.kind !== 'hidden' || owner.partId !== this.context.partId
      || owner.generation !== this.context.generation) { this.unproved = true; return; }
    const existing = this.held.get(owner.dispatchId);
    if (existing !== undefined && existing !== owner) {
      // A conflicting identity is not another valid registration of this lease. Keep
      // the established owner and refuse certification; never free another owner's lease.
      this.unproved = true; return;
    }
    if (existing === undefined && this.held.size >= 128) {
      this.unproved = true;
      // The actual reply already exists. Its bridge registry owns it independently of
      // this bounded Scope; false/throw keeps that owner in the bridge's failed-only queue.
      // This is not a pre-dispatch admission or a physical-memory-zero assertion.
      try { await this.bridge.releaseReferenceMeshLease?.(owner); } catch { /* Bridge retains failed owner. */ }
      return;
    }
    this.held.set(owner.dispatchId, owner);
    if (!this.closed) for (const body of bodies) {
      if (!owner.steps.some(step => step.id === body.featureId)) { this.unproved = true; continue; }
      // Re-registration cannot replace an already issued layout with a mutated one.
      if (this.bodyClaims.has(body)) continue;
      const mesh = body.mesh, frame = body.coordinateFrame;
      const arrays = [mesh.positions, mesh.normals, mesh.indices, mesh.edgePositions];
      this.bodyClaims.set(body, { owner, featureId: body.featureId, mesh: new WeakRef(mesh),
        arrays: arrays.map(array => new WeakRef(array)), backings: arrays.map(array => new WeakRef(array.buffer)),
        byteLengths: arrays.map(array => array.byteLength), frame: frame === undefined ? null : new WeakRef(frame),
        origin: frame?.origin.slice() ?? [], triangleCount: mesh.triangleCount,
        error: frame?.maximumFloat32ErrorMm, budget: frame?.maximumLiveMeshBytes });
    }
    if (this.closed) {
      const before = this.releaseAttempts.get(owner.dispatchId) ?? 0;
      await this.close();
      // The prior iterator may already have finished, whether another owner succeeded or
      // failed. Attempt this new owner once; do not retry this new owner
      // merely because another owner made the close result false.
      if (this.held.has(owner.dispatchId) && (this.releaseAttempts.get(owner.dispatchId) ?? 0) === before) await this.close();
    }
  }
  async capture(observationId: string, displayBodies: readonly SolidBody[], additionalOwners: readonly MeshLedgerOwner[] = []): Promise<CurrentMeshLedgerReceipt> {
    const unknown = (reason: string): CurrentMeshLedgerReceipt => ({ status: 'unknown', observationId, reason });
    if (!this.current) return unknown('reference-scope-not-current');
    const display = displayBodies.length === 0 ? null : this.bridge.meshLedgerOwner?.(displayBodies);
    if (displayBodies.length > 0 && (display === undefined || display === null)) return unknown('display-owner-unavailable');
    const capture = this.bridge.captureCurrentMeshLedger;
    if (capture === undefined) return unknown('current-ledger-unavailable');
    const owners = [...new Set([...(display === null || display === undefined ? this.owners : [display, ...this.owners]), ...additionalOwners])];
    const receipt = await capture({ observationId, owners });
    if (!this.current) return unknown('reference-scope-changed');
    if (this.bridge.currentMeshLedgerReceipt?.(receipt) !== true)
      return receipt.status === 'unknown' ? receipt : unknown('reference-scope-changed');
    if (receipt.status === 'known') this.issuedReceipts.add(receipt);
    return receipt;
  }
  /** Synchronous managed freshness only; callers must obtain a fresh async capture for publication. */
  currentReceipt(receipt: CurrentMeshLedgerReceipt): boolean {
    return this.current && this.issuedReceipts.has(receipt) && this.bridge.currentMeshLedgerReceipt?.(receipt) === true;
  }
  /** Read-only identity intersection. It neither registers UI arrays as Source nor releases the borrowed lease. */
  async inspectBackings(receipt: CurrentMeshLedgerReceipt, buffers: readonly ArrayBufferLike[]): Promise<SourceMeshBackingInspection> {
    const unknown = (reason: string): SourceMeshBackingInspection => ({ status: 'unknown', reason });
    if (!this.currentReceipt(receipt)) return unknown('reference-preview-receipt-not-current');
    for (const buffer of buffers) {
      if (!(buffer instanceof ArrayBuffer)) return unknown('reference-preview-backing-not-supported');
      try { new Uint8Array(buffer); } catch { return unknown('reference-preview-backing-detached'); }
    }
    const inspect = this.bridge.inspectSourceMeshBackings;
    if (inspect === undefined || this.bridge.currentSourceMeshBackingInspection === undefined) return unknown('reference-preview-membership-unavailable');
    try {
      const inspection = await inspect(receipt, buffers);
      return this.currentInspection(inspection, receipt) ? inspection : unknown('reference-preview-membership-changed');
    } catch { return unknown('reference-preview-membership-failed'); }
  }
  currentInspection(inspection: SourceMeshBackingInspection, receipt: CurrentMeshLedgerReceipt): boolean {
    return this.currentReceipt(receipt) && inspection.status === 'known'
      && this.bridge.currentSourceMeshBackingInspection?.(inspection, receipt) === true;
  }
  /** Exact body/layout admitted by a bridge-issued hidden reply, not a caller-created snapshot. */
  referenceBodyCurrent(body: SolidBody): boolean {
    const claim = this.bodyClaims.get(body), mesh = body.mesh, frame = body.coordinateFrame;
    if (!this.current || claim === undefined || this.held.get(claim.owner.dispatchId) !== claim.owner
      || body.featureId !== claim.featureId || mesh !== claim.mesh.deref() || mesh.triangleCount !== claim.triangleCount
      || (frame ?? null) !== (claim.frame?.deref() ?? null) || frame?.maximumFloat32ErrorMm !== claim.error
      || frame?.maximumLiveMeshBytes !== claim.budget || frame !== undefined
        && !frame.origin.every((value, index) => value === claim.origin[index])) return false;
    const arrays = [mesh.positions, mesh.normals, mesh.indices, mesh.edgePositions];
    return arrays.every((array, index) => {
      if (array !== claim.arrays[index]?.deref() || array.buffer !== claim.backings[index]?.deref()
        || array.byteLength !== claim.byteLengths[index] || !(array.buffer instanceof ArrayBuffer)) return false;
      try { new Uint8Array(array.buffer); return true; } catch { return false; }
    });
  }

  close(): Promise<boolean> {
    this.closed = true;
    this.reads.clear(); // Deletes this scope's strong references only; external old borrowers remain independently counted.
    if (this.closing !== null) return this.closing;
    this.closing = this.releaseHeld().finally(() => { this.closing = null; });
    return this.closing;
  }
  private async releaseHeld(): Promise<boolean> {
    let released = true;
    for (const [id, owner] of this.held) {
      this.releaseAttempts.set(id, (this.releaseAttempts.get(id) ?? 0) + 1);
      try {
        const result = await this.bridge.releaseReferenceMeshLease?.(owner);
        if (result?.released === true || result?.absent === true || result?.closed === true) {
          this.held.delete(id); this.releaseAttempts.delete(id);
        }
        else { this.unproved = true; released = false; }
      } catch { this.unproved = true; released = false; }
    }
    return released;
  }
}
export interface ReferenceBodiesRequest {
  readonly steps: readonly ResolvedSolidStep[];
  readonly bodies: readonly SolidBody[];
  readonly featureIds: Iterable<string>;
  readonly failedIds: ReadonlySet<string>;
  readonly bridge: Pick<KernelBridge, 'readCachedBodies'>;
  readonly shouldCancel: () => boolean;
  readonly reads?: ReferenceBodyReads;
  readonly scope?: ReferenceMeshScope;
  readonly features?: readonly { readonly id: string; readonly suppressed: boolean }[];
}
export interface ReferenceBodiesResult {
  readonly bodies: readonly SolidBody[];
  readonly missing: ReadonlyMap<string, ReferenceBodyMissingReason>;
  readonly cancelled: boolean;
}

function bodyResult(bodies: readonly SolidBody[], id: string): CachedReferenceBody {
  const found = bodies.filter(body => body.featureId === id);
  if (found.length > 1) return { reason: 'ambiguous-body' };
  if (found.length === 0) return { reason: 'unavailable' };
  return found[0].isValid ? { body: found[0] } : { reason: 'invalid-body' };
}

/** Reads only current hidden steps. Does not toggle visibility or build an evicted shape. */
export async function readReferenceBodies(request: ReferenceBodiesRequest): Promise<ReferenceBodiesResult> {
  const missing = new Map<string, ReferenceBodyMissingReason>();
  const steps = new Map(request.steps.map(step => [step.featureId, step]));
  const bodies = request.bodies.filter(body => steps.has(body.featureId) && !request.failedIds.has(body.featureId));
  const reads = request.reads ?? request.scope?.reads ?? new Map<string, CachedReferenceBody>();
  const needed: ResolvedSolidStep[] = [];
  const keyOf = (step: ResolvedSolidStep): string => JSON.stringify([step.featureId, step.key]);
  const use = (id: string, result: CachedReferenceBody): void => {
    if ('body' in result) bodies.push(result.body);
    else missing.set(id, result.reason);
  };
  for (const id of new Set(request.featureIds)) {
    const step = steps.get(id);
    if (request.failedIds.has(id)) { missing.set(id, 'failed'); continue; }
    if (step === undefined) {
      const feature = request.features?.find(value => value.id === id);
      missing.set(id, request.features === undefined ? 'unresolved-step'
        : feature === undefined ? 'deleted' : feature.suppressed ? 'suppressed' : 'unresolved-step');
      continue;
    }
    if (step.key.length === 0) { missing.set(id, 'unavailable'); continue; }
    if (bodies.some(body => body.featureId === id)) {
      const result = bodyResult(bodies, id);
      if ('reason' in result) missing.set(id, result.reason);
      continue;
    }
    if (step.visible) { missing.set(id, 'unavailable'); continue; }
    const cached = reads.get(keyOf(step));
    if (cached !== undefined) use(id, cached);
    else if (request.bridge.readCachedBodies === undefined) missing.set(id, 'unsupported');
    else needed.push(step);
  }
  const finish = (cancelled: boolean): ReferenceBodiesResult => ({
    bodies: cancelled ? [] : bodies.filter(body => !missing.has(body.featureId)), missing, cancelled,
  });
  if (request.shouldCancel()) { await request.scope?.close(); return finish(true); }
  if (needed.length === 0 || request.bridge.readCachedBodies === undefined) return finish(false);
  try {
    const result = await request.bridge.readCachedBodies(request.steps, needed.map(step => step.featureId), request.scope === undefined ? undefined : {
      ...request.scope.context, shouldCancel: () => request.shouldCancel() || request.scope?.readsClosed === true });
    if (request.scope !== undefined) await request.scope.register(result.bodies);
    if (result.cancelled || request.shouldCancel()) { await request.scope?.close(); return finish(true); }
    const failed = new Set(result.failures.map(failure => failure.featureId));
    for (const step of needed) {
      const value: CachedReferenceBody = failed.has(step.featureId)
        ? { reason: 'read-failed' } : bodyResult(result.bodies, step.featureId);
      reads.set(keyOf(step), value);
      use(step.featureId, value);
    }
  } catch {
    if (request.shouldCancel()) { await request.scope?.close(); return finish(true); }
    for (const step of needed) {
      const value: CachedReferenceBody = { reason: 'read-failed' };
      reads.set(keyOf(step), value);
      use(step.featureId, value);
    }
  }
  return finish(false);
}
