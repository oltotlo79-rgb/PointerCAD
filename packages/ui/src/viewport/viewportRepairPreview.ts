import type * as THREE from 'three';
import {
  recordReferenceRepairRejection, borrowReferenceRepairPreview, type ReferenceRepairPreview,
  type ReferenceRepairPreviewBorrow, type RepairPreviewReceipt, type RepairPreviewInspection,
} from '../solid/referenceRepairPreview.js';
import type { DisplayStyle } from '../store/viewSlice.js';
import type { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import { AllocatedBackingRegistrationError, EMPTY_SOLID_GEOMETRY } from './buildSolidGeometry.js';
import { buildSubShapeGeometry, subShapeOverlayBytes, type SubShapeHighlightBundle } from './buildSubShapeGeometry.js';
import { createSolidLayer } from './createSolidLayer.js';
import { ViewportResourceInitializationFailure, type ViewportLifetime } from './viewportLifetime.js';
import type { createViewportMeshObservation, ViewportMeshOwner } from './viewportMeshObservation.js';
import type { GpuMeshBudget, SolidMeshAdmissionState } from './solidMeshAdmission.js';

interface RepairPreviewServices {
  readonly readSolidMeshState?: () => SolidMeshAdmissionState;
  readonly gpuMeshBudget?: GpuMeshBudget;
  readonly observation?: ReturnType<typeof createViewportMeshObservation>;
  readonly viewportOwnerId?: string;
}

/**
 * Owns only the repair overlay and its reservations, never the borrowed Source.
 * Requests, asynchronous provider observations and retryable native returns have
 * one lifetime here. The scene supplies an attachment and the current style;
 * ordinary bodies, picking, camera state and saved documents never enter it.
 */
export function createViewportRepairPreview(
  scene: Pick<THREE.Scene, 'add' | 'remove'>,
  uiBackings: AssemblyUiBackingLedger,
  options: RepairPreviewServices,
  readDisplayStyle: () => DisplayStyle | undefined,
) {
  let disposed = false;
  let repairPreviewRequest = 0;
  let requestedRepairPreview: ReferenceRepairPreview | null = null;
  let repairPreviewPending: Promise<void> | null = null;
  let completedRepairPreviewRequest = -1;
  let nextResourceCycle = 0;
  const returnedRepairPreviews = new WeakSet<ViewportMeshOwner>();
  interface RepairPreviewResource {
    readonly descriptor: ReferenceRepairPreview;
    readonly observedOwner: ViewportMeshOwner;
    readonly gpuOwner: symbol;
    readonly gpuBytes: number;
    readonly cpuBytes: number;
    readonly layer: ReturnType<typeof createSolidLayer> | null;
    readonly cleanup: ViewportLifetime | null;
    readonly proof: () => boolean;
    retiring: boolean;
    published: boolean;
    cleanupError: string | null;
  }
  let repairPreviewResource: RepairPreviewResource | null = null;

  // One hover descriptor may be republished after its proof expires. Each build
  // owns different copies/native resources and therefore needs its own terminal.
  function repairPreviewOwner(descriptor: ReferenceRepairPreview): ViewportMeshOwner {
    const viewportOwnerId = options.viewportOwnerId ?? 'unobserved';
    const cycle = `${descriptor.operationId}:${++nextResourceCycle}`;
    return Object.freeze({ documentId: descriptor.documentId, generation: descriptor.generation, preview: true,
      viewportOwnerId, resourceOwnerId: `${viewportOwnerId}:repair-preview:${cycle}`,
      operationId: `repair-preview-operation-${cycle}`, publicationId: `repair-preview-publication-${cycle}` });
  }

  function observeRepairPreview(owner: ViewportMeshOwner,
    phase: Parameters<NonNullable<RepairPreviewServices['observation']>['record']>[1],
    reason: Parameters<NonNullable<RepairPreviewServices['observation']>['record']>[2],
    copies: number, attributes: number, reserved: number | null = null): void {
    try {
      options.observation?.record(owner,
        phase, reason, { hostDisplayCopyBytes: copies, hostGpuAttributeBytes: attributes, hostGpuReservedBytes: reserved });
    } catch { /* Diagnostic callbacks cannot interrupt ownership transfer or an actual return. */ }
  }

  function repairPreviewProof(scope: WeakRef<ReferenceRepairPreviewBorrow['scope']>, receipt: RepairPreviewReceipt,
    inspection: RepairPreviewInspection, input: WeakSet<ArrayBufferLike>, epoch: number): () => boolean {
    return () => {
      if (receipt.status !== 'known' || inspection.status !== 'known'
        || scope.deref()?.currentInspection(inspection, receipt) !== true || !uiBackings.known()) return false;
      const source = new Set<ArrayBufferLike>();
      for (const reference of inspection.sameSourceBackings) {
        const buffer = reference.deref(); if (buffer !== undefined) source.add(buffer);
      }
      let total = receipt.admittedBoundBytes + uiBackings.pending();
      for (const buffer of uiBackings.buffers()) {
        if (!(buffer instanceof ArrayBuffer) || !input.has(buffer) && !uiBackings.allocatedAfter(buffer, epoch)) return false;
        try { new Uint8Array(buffer); } catch { return false; }
        if (!source.has(buffer)) total += buffer.byteLength;
      }
      return Number.isSafeInteger(total) && total <= receipt.limitBytes;
    };
  }

  function returnRepairPreview(): boolean {
    const resource = repairPreviewResource;
    if (resource === null) return true;
    if (!resource.retiring) observeRepairPreview(resource.observedOwner, resource.published ? 'release-start' : 'candidate-return-start',
      disposed ? 'disposed' : resource.published ? 'superseded' : 'rejected', resource.cpuBytes, resource.gpuBytes);
    resource.retiring = true;
    if (resource.layer !== null) resource.layer.group.visible = false;
    try {
      if (resource.layer !== null) resource.layer.dispose();
      if (resource.cleanup !== null) {
        resource.cleanup.dispose();
        if (resource.cleanup.pendingCount !== 0) { resource.cleanupError = resource.cleanup.errors.join('; '); return false; }
      }
    } catch (error) {
      resource.cleanupError = error instanceof Error ? error.message : 'Reference repair preview return failed';
      return false;
    }
    if (resource.layer !== null) scene.remove(resource.layer.group);
    options.gpuMeshBudget?.release(resource.gpuOwner);
    repairPreviewResource = null;
    returnedRepairPreviews.add(resource.observedOwner);
    observeRepairPreview(resource.observedOwner, resource.published ? 'release-complete' : 'candidate-return-complete',
      disposed ? 'disposed' : resource.published ? 'superseded' : 'rejected', 0, 0, 0);
    return true;
  }

  function currentRepairPreviewResource(): boolean {
    const resource = repairPreviewResource;
    if (resource === null) return true;
    const state = options.readSolidMeshState?.();
    if (!disposed && !resource.retiring && requestedRepairPreview === resource.descriptor && state !== undefined
      && borrowReferenceRepairPreview(resource.descriptor, state) !== null && resource.proof()) return true;
    returnRepairPreview();
    return false;
  }

  async function observeRepairPreviewBudget(descriptor: ReferenceRepairPreview) {
    const state = options.readSolidMeshState?.();
    const borrowed = state === undefined ? null : borrowReferenceRepairPreview(descriptor, state);
    if (borrowed === null || disposed || requestedRepairPreview !== descriptor || !uiBackings.known()) return recordReferenceRepairRejection('scene-budget:1');
    // This is a fresh asynchronous provider observation, not a reused display receipt.
    const receipt = await borrowed.scope.capture(`repair-preview:${descriptor.operationId}`, borrowed.displayBodies, borrowed.additionalOwners);
    const after = options.readSolidMeshState?.();
    if (after === undefined) return recordReferenceRepairRejection('scene-budget:2:after-unavailable');
    if (borrowReferenceRepairPreview(descriptor, after)?.scope !== borrowed.scope) return recordReferenceRepairRejection('scene-budget:2:scope-changed');
    if (disposed) return recordReferenceRepairRejection('scene-budget:2:disposed');
    if (requestedRepairPreview !== descriptor) return recordReferenceRepairRejection('scene-budget:2:descriptor-changed');
    if (receipt.status !== 'known') return recordReferenceRepairRejection(`scene-budget:2:receipt-unknown:${receipt.reason}`.slice(0, 120));
    const numbers = [receipt.limitBytes, receipt.admittedBoundBytes, receipt.workerRetainedBackingBytes,
      receipt.hostRetainedBackingBytes, receipt.pendingCloneReservedBytes];
    if (!numbers.every(value => Number.isSafeInteger(value) && value >= 0)
      || receipt.limitBytes <= 0 || receipt.limitBytes > 512 * 1024 * 1024
      || receipt.admittedBoundBytes !== receipt.workerRetainedBackingBytes + receipt.hostRetainedBackingBytes + receipt.pendingCloneReservedBytes
      || receipt.coverage !== 'registered-solid-mesh-backings-only' || !borrowed.scope.currentReceipt(receipt)) return recordReferenceRepairRejection('scene-budget:3');
    const buffers = uiBackings.buffers(), epoch = uiBackings.epoch();
    const inspection = await borrowed.scope.inspectBackings(receipt, buffers);
    const latest = options.readSolidMeshState?.();
    if (latest === undefined || borrowReferenceRepairPreview(descriptor, latest)?.scope !== borrowed.scope
      || disposed || requestedRepairPreview !== descriptor || inspection.status !== 'known'
      || inspection.coverage !== 'registered-main-solid-backings-only' || uiBackings.epoch() !== epoch
      || !uiBackings.known() || !borrowed.scope.currentInspection(inspection, receipt)) return recordReferenceRepairRejection('scene-budget:4');
    const input = new WeakSet<ArrayBufferLike>(buffers);
    const sourceBackings = new Set<ArrayBufferLike>();
    for (const reference of inspection.sameSourceBackings) {
      const buffer = reference.deref();
      if (buffer !== undefined) {
        if (!input.has(buffer)) return recordReferenceRepairRejection('scene-budget:5');
        sourceBackings.add(buffer);
      }
    }
    const current = repairPreviewProof(new WeakRef(borrowed.scope), receipt, inspection, input, epoch);
    const baseline = receipt.admittedBoundBytes;
    const union = baseline + buffers.filter(buffer => !sourceBackings.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0)
      + uiBackings.pending();
    if (!Number.isSafeInteger(union) || union > receipt.limitBytes || !current()) return recordReferenceRepairRejection('scene-budget:6');
    return { borrowed, receipt, sourceBackings, baseline, union, current };
  }

  function setReferenceRepairPreview(descriptor: ReferenceRepairPreview | null): Promise<void> {
    if (disposed) return Promise.resolve();
    if (descriptor !== requestedRepairPreview) {
      requestedRepairPreview = descriptor; repairPreviewRequest++;
      returnRepairPreview(); // Hide immediately, even while a provider query is pending.
    } else if (repairPreviewResource !== null && currentRepairPreviewResource()) return Promise.resolve();
    if (repairPreviewPending !== null) return repairPreviewPending;
    const pending = drainRepairPreview();
    repairPreviewPending = pending;
    const completed = () => {
      if (repairPreviewPending !== pending) return;
      repairPreviewPending = null;
      if (!disposed && completedRepairPreviewRequest !== repairPreviewRequest) {
        void setReferenceRepairPreview(requestedRepairPreview).catch(() => { returnRepairPreview(); });
      }
    };
    void pending.then(completed, () => { returnRepairPreview(); completed(); });
    return pending;
  }

  async function drainRepairPreview(): Promise<void> {
    // One provider transaction at a time; repeated hover retains only the newest metadata.
    let completed = -1;
    while (!disposed && completed !== repairPreviewRequest) {
      completed = repairPreviewRequest;
      completedRepairPreviewRequest = completed;
      const descriptor = requestedRepairPreview;
      if (!returnRepairPreview() || descriptor === null) return;
      await buildRepairPreview(descriptor, completed);
    }
  }

  async function buildRepairPreview(descriptor: ReferenceRepairPreview, request: number): Promise<void> {
    const alive = () => !disposed && request === repairPreviewRequest && requestedRepairPreview === descriptor;
    const cpuOwner = {};
    const observedOwner = repairPreviewOwner(descriptor);
    let gpuOwner: symbol | null = null;
    let buildStarted = false, published = false, allocatedBytes = 0;
    try {
      const before = await observeRepairPreviewBudget(descriptor);
      if (!alive() || before === null || options.gpuMeshBudget === undefined) return;
      buildStarted = true;
      observeRepairPreview(observedOwner, 'build-start', null, 0, 0);
      // The reservation lasts only through the synchronous count/fill transaction.
      uiBackings.reserve(cpuOwner, before.receipt.limitBytes - before.union, before.baseline,
        before.receipt.limitBytes, before.sourceBackings);
      let overlays: SubShapeHighlightBundle;
      try {
        overlays = buildSubShapeGeometry([before.borrowed.body], descriptor.elementId, [],
          { limitBytes: before.receipt.limitBytes, reservedBytes: before.union }, buffer => {
            allocatedBytes += buffer.byteLength; uiBackings.allocated(buffer);
          });
      } finally { uiBackings.retire(cpuOwner); }
      const bytes = subShapeOverlayBytes(overlays);
      observeRepairPreview(observedOwner, 'build-complete', 'completed', allocatedBytes, 0);
      if (bytes === 0 || !alive()) return;
      // Actual copies have now been registered. Observe all providers again before native publication.
      const publication = await observeRepairPreviewBudget(descriptor);
      if (!alive() || publication === null || !publication.current()) return;
      gpuOwner = Symbol(`repair-preview:${descriptor.operationId}`);
      if (!options.gpuMeshBudget.reserve(gpuOwner, bytes)) { gpuOwner = null; return; }
      observeRepairPreview(observedOwner, 'publish-start', null, allocatedBytes, 0,
        options.gpuMeshBudget.reservedBytes?.(gpuOwner) ?? null);
      let candidateLayer: ReturnType<typeof createSolidLayer>;
      try { candidateLayer = createSolidLayer(); }
      catch (error) {
        if (error instanceof ViewportResourceInitializationFailure && error.cleanup.pendingCount !== 0) {
          repairPreviewResource = { descriptor, observedOwner, gpuOwner, gpuBytes: 0, cpuBytes: 0,
            layer: null, cleanup: error.cleanup, proof: () => false, retiring: false, published: false, cleanupError: null };
          gpuOwner = null;
        }
        throw error;
      }
      repairPreviewResource = { descriptor, observedOwner, gpuOwner, gpuBytes: bytes, cpuBytes: bytes,
        layer: candidateLayer, cleanup: null, proof: publication.current, retiring: false, published: false, cleanupError: null };
      gpuOwner = null;
      candidateLayer.group.visible = false;
      candidateLayer.update(EMPTY_SOLID_GEOMETRY, readDisplayStyle() ?? 'shadedWithEdges', null);
      candidateLayer.updateSubShapes(overlays);
      const placement = publication.borrowed.placement;
      if (placement !== null) {
        candidateLayer.group.position.set(...placement.position);
        candidateLayer.group.quaternion.set(...placement.rotation);
      }
      candidateLayer.group.updateMatrix();
      // Batch origins stay local Double transforms beneath the actual Assembly placement.
      if (!alive() || !currentRepairPreviewResource()) { returnRepairPreview(); return; }
      scene.add(candidateLayer.group);
      candidateLayer.group.visible = true;
      published = true;
      if (repairPreviewResource !== null) repairPreviewResource.published = true;
      observeRepairPreview(observedOwner, 'publish-complete', 'completed', allocatedBytes, bytes);
    } catch (error) {
      if (error instanceof AllocatedBackingRegistrationError) uiBackings.retainUnregistered(error.backing);
      returnRepairPreview();
      // Unavailable/unknown is a hidden preview, never a success proof or a document mutation.
    } finally {
      uiBackings.retire(cpuOwner);
      if (gpuOwner !== null) options.gpuMeshBudget?.release(gpuOwner);
      if (buildStarted && !published) {
        observeRepairPreview(observedOwner, 'operation-aborted', 'rejected', allocatedBytes, 0);
        if (repairPreviewResource?.observedOwner !== observedOwner && !returnedRepairPreviews.has(observedOwner)) {
          observeRepairPreview(observedOwner, 'candidate-return-start', 'rejected', allocatedBytes, 0);
          observeRepairPreview(observedOwner, 'candidate-return-complete', 'rejected', 0, 0, 0);
          returnedRepairPreviews.add(observedOwner);
        }
      }
    }
  }

  return {
    setReferenceRepairPreview,
    ensureCurrent: currentRepairPreviewResource,
    /** Invalidate late replies before the scene starts returning any resources. */
    retire(): void {
      if (disposed) return;
      disposed = true;
      repairPreviewRequest++; requestedRepairPreview = null;
    },
    returnResources: returnRepairPreview,
    meshReservation() {
      const resource = repairPreviewResource;
      return {
        displayCopyBytes: resource?.cpuBytes ?? 0,
        gpuMeshBytes: resource?.gpuBytes ?? 0,
        cleanupPending: resource?.retiring === true,
        cleanupErrors: Object.freeze(resource?.cleanupError === null || resource?.cleanupError === undefined
          ? [] : [resource.cleanupError]),
        uncovered: Object.freeze(resource !== null && (resource.retiring || !resource.proof())
          ? ['referenceRepairPreviewCleanup'] : []),
      };
    },
  };
}
