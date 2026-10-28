import { recomputePart, createPrimitiveFeature, type KernelBridge, type SolidBody } from '@pointercad/model';
import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { repairFixture } from '../solid/referenceRepairFixture.js';
import { currentRepairSlots } from '../solid/referenceRepairContext.js';
import { beginReferenceRepair, hoverReferenceRepair, cancelReferenceRepair } from '../solid/referenceRepair.js';
import { currentReferenceRepairPreview } from '../solid/referenceRepairPreview.js';
import { AssemblyUiBackingLedger } from './assemblyMeshAdmission.js';
import { createGpuMeshBudget, type SolidMeshAdmissionState } from './solidMeshAdmission.js';
import { createViewportMeshObservation } from './viewportMeshObservation.js';
import { createViewportLifetime, ViewportResourceInitializationFailure } from './viewportLifetime.js';
import { createViewportRepairPreview } from './viewportRepairPreview.js';

const fault = vi.hoisted((): {
  build: 'before' | 'after' | null;
  construct: (() => void) | null;
  update: (() => void) | null;
} => ({ build: null, construct: null, update: null }));

vi.mock('./buildSubShapeGeometry.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./buildSubShapeGeometry.js')>();
  return { ...actual, buildSubShapeGeometry: (...args: Parameters<typeof actual.buildSubShapeGeometry>) => {
    if (fault.build === 'before') throw new Error('before overlay allocation');
    const overlays = actual.buildSubShapeGeometry(...args);
    if (fault.build === 'after') throw new Error('after overlay allocation');
    return overlays;
  } };
});
vi.mock('./createSolidLayer.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./createSolidLayer.js')>();
  return { ...actual, createSolidLayer: () => {
    fault.construct?.();
    const layer = actual.createSolidLayer();
    return { ...layer, updateSubShapes: (...args: Parameters<typeof layer.updateSubShapes>) => {
      layer.updateSubShapes(...args); fault.update?.();
    } };
  } };
});

afterEach(() => {
  fault.build = null; fault.construct = null; fault.update = null;
  vi.restoreAllMocks();
});

// The provider fixture matches the existing scene integration fixture. Tests stay in both boundaries.
async function controlledRepairPreviewSource(assemblySource = false) {
  resetTestStore();
  const original = repairFixture();
  const fixture = assemblySource ? { ...original, document: { ...original.document,
    solids: original.document.solids.map(feature => feature.id === 'base'
      ? { ...createPrimitiveFeature(original.document, 'box'), id: feature.id, name: feature.name } : feature) } } : original;
  const body: SolidBody = { ...fixture.body, coordinateFrame: { space: 'local', origin: [0, 0, 0],
    maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 1024 * 1024 }, mesh: { ...fixture.body.mesh,
    edgePositions: new Float32Array([-5, 0, 0, 5, 0, 0, -20, 0, 0, 20, 0, 0]) } };
  const hiddenBodies = [body], displayBodies: readonly SolidBody[] = [];
  type Owner = NonNullable<ReturnType<NonNullable<KernelBridge['meshLedgerOwner']>>>;
  type Receipt = Awaited<ReturnType<NonNullable<KernelBridge['captureCurrentMeshLedger']>>>;
  type Inspection = Awaited<ReturnType<NonNullable<KernelBridge['inspectSourceMeshBackings']>>>;
  const owner: Owner = { dispatchId: 'hidden-preview-fixture', partId: 'preview-fixture', generation: 7,
    kind: 'hidden', steps: [{ id: 'base', key: 'base-key' }] };
  const receipts = new WeakSet<Receipt>(), inspections = new WeakMap<Inspection, Receipt>();
  const sourceBuffers = new Set([body.mesh.positions.buffer, body.mesh.normals.buffer, body.mesh.indices.buffer, body.mesh.edgePositions.buffer]);
  let providerCurrent = true, observations = 0, limit = 1024 * 1024;
  let delay: (() => Promise<void>) | null = null;
  function unused(): never { throw new Error('Unused geometry operation in controlled provider fixture'); }
  const bridge: KernelBridge = {
    tessellateSketchFaces: unused, offsetSketchCurves: unused, projectSketchCurves: unused,
    sectionSketchCurves: unused, measure: unused, exportShapes: unused, importShape: unused,
    inspectPrintability: unused, dispose() { providerCurrent = false; },
    recomputeSolids: () => Promise.resolve({ bodies: displayBodies, cacheHits: 0, cancelled: false, failures: [] }),
    meshLedgerOwner: bodies => bodies === hiddenBodies ? owner : null,
    readCachedBodies: () => Promise.resolve({ bodies: hiddenBodies, cacheHits: 1, cancelled: false, failures: [] }),
    releaseReferenceMeshLease: () => Promise.resolve({ released: true }),
    captureCurrentMeshLedger: async input => {
      observations++;
      if (delay !== null) await delay();
      if (!providerCurrent || input.owners.some(value => value !== owner)) return { status: 'unknown', observationId: input.observationId, reason: 'unissued-owner' };
      const bytes = [...sourceBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      const receipt: Receipt = { status: 'known', observationId: input.observationId, hostEpoch: 1,
        workerEpochs: [{ providerId: 1, connectionEpoch: 1, cache: 1, owners: 1 }], owners: input.owners,
        limitBytes: limit, workerRetainedBackingBytes: bytes, hostRetainedBackingBytes: bytes,
        pendingCloneReservedBytes: 0, admittedBoundBytes: bytes * 2, coverage: 'registered-solid-mesh-backings-only',
        unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
      receipts.add(receipt); return receipt;
    },
    currentMeshLedgerReceipt: receipt => providerCurrent && receipts.has(receipt),
    inspectSourceMeshBackings: (receipt, buffers) => new Promise<Inspection>(resolve => {
      if (!providerCurrent || !receipts.has(receipt)) { resolve({ status: 'unknown', reason: 'unissued-receipt' }); return; }
      const unique = new Set<ArrayBuffer>();
      for (const buffer of buffers) {
        if (!(buffer instanceof ArrayBuffer)) { resolve({ status: 'unknown', reason: 'unsupported' }); return; }
        try { new Uint8Array(buffer); } catch { resolve({ status: 'unknown', reason: 'detached' }); return; }
        unique.add(buffer);
      }
      const matched = [...unique].filter(buffer => sourceBuffers.has(buffer));
      const inspection: Inspection = { status: 'known', hostEpoch: 1,
        inputBackingBytes: [...unique].reduce((sum, buffer) => sum + buffer.byteLength, 0),
        additionalBackingBytes: [...unique].filter(buffer => !sourceBuffers.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0),
        sameSourceBackings: matched.map(buffer => new WeakRef(buffer)), coverage: 'registered-main-solid-backings-only',
        unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
      inspections.set(inspection, receipt); resolve(inspection);
    }),
    currentSourceMeshBackingInspection: (inspection, receipt) => providerCurrent && inspections.get(inspection) === receipt && receipts.has(receipt),
  };
  const result = await recomputePart(fixture.document, bridge, { generation: 7, partId: 'preview-fixture' });
  const scope = result.referenceMeshScope;
  if (scope === undefined || !scope.current) throw new Error('Real model-created current scope required for controlled provider');
  await scope.register(hiddenBodies);
  return { fixture, body, displayBodies, hiddenBodies, result, scope, owner, bridge,
    observations: () => observations, setLimit: (bytes: number) => { limit = bytes; },
    setDelay: (wait: (() => Promise<void>) | null) => { delay = wait; },
    invalidate: () => { providerCurrent = false; } };
}

async function controlledRepairPreview() {
  const source = await controlledRepairPreviewSource();
  const { fixture, body, displayBodies, hiddenBodies, result, scope, owner, bridge } = source;
  useAppStore.getState().applyDocument(fixture.document);
  useAppStore.setState({ bodies: displayBodies, partErrors: [], isComputing: false, requestedGeneration: 7,
    completedGeneration: 7, lastOutcome: 'success', recomputeCancelled: false, timelineIndex: null,
    referenceRepairBodies: { document: fixture.document, activeDocumentId: useAppStore.getState().activeDocumentId,
      generation: 7, bodies: hiddenBodies, displayBodies, scope } });
  const slot = currentRepairSlots(useAppStore.getState()).find(item => item.ownerId === 'blend');
  const session = slot === undefined ? null : beginReferenceRepair(slot.key);
  if (session === null || session.candidates.length !== 2) throw new Error('Exact current upstream candidates required');
  const hover = () => {
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    const preview = currentReferenceRepairPreview(useAppStore.getState());
    if (preview === null) throw new Error('Issued metadata required');
    return preview;
  };
  return { body, displayBodies, hiddenBodies, document: fixture.document, scope, session, hover, bridge,
    result: { ...result, referenceBodies: hiddenBodies }, hiddenOwner: owner,
    observations: source.observations, setLimit: source.setLimit, setDelay: source.setDelay, invalidate: source.invalidate,
    close: async () => { cancelReferenceRepair(session); await scope.close(); bridge.dispose(); resetTestStore(); } };
}

async function previewOwner(gpuLimit = 1024 * 1024) {
  const source = await controlledRepairPreview();
  const scene = new THREE.Scene(), ui = new AssemblyUiBackingLedger(), gpu = createGpuMeshBudget(gpuLimit);
  const observation = createViewportMeshObservation('repair-boundary');
  let sceneState: SolidMeshAdmissionState | null = null;
  const owner = createViewportRepairPreview(scene, ui, { readSolidMeshState: () => sceneState ?? useAppStore.getState(),
    gpuMeshBudget: gpu, observation, viewportOwnerId: 'repair-boundary' }, () => 'shadedWithEdges');
  return { ...source, scene, ui, gpu, observation, owner,
    replaceState: (state: SolidMeshAdmissionState) => { sceneState = state; },
    close: async () => { owner.retire(); owner.returnResources(); await source.close(); } };
}

function overlayGeometry(scene: THREE.Scene): THREE.BufferGeometry {
  let result: THREE.BufferGeometry | null = null;
  scene.traverse(object => {
    if (!(object instanceof THREE.LineSegments)) return;
    const geometry: unknown = object.geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    const attribute: unknown = geometry.getAttribute('position');
    if (attribute instanceof THREE.BufferAttribute && attribute.array instanceof Float32Array
      && attribute.itemSize === 3 && attribute.count === 2 && attribute.array.byteLength === 24) result = geometry;
  });
  if (result === null) throw new Error('Actual 24-byte overlay geometry required');
  return result;
}

describe('repair preview owns candidates and reservations independently of the scene', () => {
  it('uses the same registered overlay backing and leaves the borrowed Source, bodies and history unchanged', async () => {
    const fixture = await previewOwner();
    try {
      const state = useAppStore.getState(), saved = JSON.stringify(state.document);
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      const geometry = overlayGeometry(fixture.scene), attribute = geometry.getAttribute('position');
      expect(fixture.observations()).toBe(2);
      expect(attribute.array).toBeInstanceOf(Float32Array);
      expect(fixture.ui.buffers()).toContain(attribute.array.buffer);
      expect(fixture.ui.bytes()).toBe(24);
      expect(fixture.owner.meshReservation()).toEqual({ displayCopyBytes: 24, gpuMeshBytes: 24,
        cleanupPending: false, cleanupErrors: [], uncovered: [] });
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(useAppStore.getState().bodies).toBe(state.bodies);
      expect(useAppStore.getState().undoStack).toBe(state.undoStack);
      expect(JSON.stringify(useAppStore.getState().document)).toBe(saved);
      await fixture.owner.setReferenceRepairPreview(null);
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
      expect(fixture.observation.snapshot()).toMatchObject({ unfinishedOwners: 0, missingRecords: 0, duplicateTerminals: 0 });
    } finally { await fixture.close(); }
  });

  it('rejects registered Source/UI union minus one byte and succeeds at the exact boundary', async () => {
    const fixture = await previewOwner();
    try {
      const source = fixture.body.mesh.positions.buffer;
      fixture.ui.adopt([source]);
      const backings = new Set([source, fixture.body.mesh.normals.buffer,
        fixture.body.mesh.indices.buffer, fixture.body.mesh.edgePositions.buffer]);
      const baseline = [...backings].reduce((sum, buffer) => sum + buffer.byteLength, 0) * 2;
      const descriptor = fixture.hover();
      fixture.setLimit(baseline + 24 - 1);
      await fixture.owner.setReferenceRepairPreview(descriptor);
      expect(fixture.owner.meshReservation().displayCopyBytes).toBe(0);
      expect(fixture.ui.bytes()).toBe(source.byteLength);
      expect(fixture.ui.pending()).toBe(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      fixture.setLimit(baseline + 24);
      await fixture.owner.setReferenceRepairPreview(descriptor);
      expect(fixture.owner.meshReservation().displayCopyBytes).toBe(24);
      expect(fixture.ui.bytes()).toBe(source.byteLength + 24);
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(fixture.scope.current).toBe(true);
    } finally { await fixture.close(); }
  });

  it.each([47, 48])('preserves another GPU owner at the %s byte union boundary', async limit => {
    const fixture = await previewOwner(limit), other = Symbol('ordinary scene');
    expect(fixture.gpu.reserve(other, 24)).toBe(true);
    try {
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      expect(fixture.owner.meshReservation().gpuMeshBytes).toBe(limit === 48 ? 24 : 0);
      expect(fixture.gpu.reservedBytes(other)).toBe(24);
      fixture.owner.retire(); expect(fixture.owner.returnResources()).toBe(true);
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(fixture.scope.current).toBe(true);
    } finally { fixture.gpu.release(other); await fixture.close(); }
  });

  it.each(['before', 'after'] as const)('returns reservations after failure %s overlay allocation', async phase => {
    const fixture = await previewOwner();
    try {
      fault.build = phase;
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.owner.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0, cleanupPending: false });
      expect(fixture.ui.pending()).toBe(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
      fault.build = null;
      await fixture.owner.setReferenceRepairPreview(currentReferenceRepairPreview(useAppStore.getState()));
      expect(fixture.owner.meshReservation().gpuMeshBytes).toBe(24);
    } finally { await fixture.close(); }
  });

  it('returns a fully constructed but unpublished layer after its update fails', async () => {
    const fixture = await previewOwner();
    try {
      fault.update = () => { throw new Error('native overlay update failed'); };
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.owner.meshReservation()).toMatchObject({ displayCopyBytes: 0, cleanupPending: false });
      expect(fixture.ui.pending()).toBe(0);
      expect(fixture.scope.current).toBe(true);
      expect(fixture.observation.snapshot().events.some(event => event.kind === 'publish-complete')).toBe(false);
    } finally { await fixture.close(); }
  });

  it('retains failed-only constructor resources and the GPU reservation until an actual retry', async () => {
    const fixture = await previewOwner(), geometry = new THREE.BufferGeometry(), material = new THREE.LineBasicMaterial();
    const cleanup = createViewportLifetime();
    const geometryReturn = vi.spyOn(geometry, 'dispose').mockImplementationOnce(() => { throw new Error('partial geometry retained'); });
    const materialReturn = vi.spyOn(material, 'dispose');
    cleanup.register('partial geometry', () => { geometry.dispose(); });
    cleanup.register('partial material', () => { material.dispose(); });
    cleanup.dispose();
    try {
      fault.construct = () => { throw new ViewportResourceInitializationFailure(new Error('constructor failed'), cleanup); };
      // Retain it through both the factory's and the preview owner's first return attempt.
      geometryReturn.mockImplementationOnce(() => { throw new Error('partial geometry retained'); });
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      expect(fixture.owner.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0, cleanupPending: true,
        cleanupErrors: ['partial geometry: partial geometry retained'], uncovered: ['referenceRepairPreviewCleanup'] });
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(cleanup.pendingCount).toBe(1);
      expect(materialReturn).toHaveBeenCalledTimes(1);
      fixture.owner.retire();
      expect(fixture.owner.returnResources()).toBe(true);
      expect(fixture.owner.returnResources()).toBe(true);
      expect(geometryReturn).toHaveBeenCalledTimes(3);
      expect(materialReturn).toHaveBeenCalledTimes(1);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
    } finally { await fixture.close(); }
  });

  it('hides a retiring actual overlay and never returns successfully released native resources twice', async () => {
    const fixture = await previewOwner();
    try {
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      const group = fixture.scene.children[0], geometry = overlayGeometry(fixture.scene);
      const returned = vi.spyOn(geometry, 'dispose').mockImplementationOnce(() => { throw new Error('overlay retained'); })
        .mockImplementationOnce(() => { throw new Error('overlay retained'); });
      const release = vi.spyOn(fixture.gpu, 'release');
      await fixture.owner.setReferenceRepairPreview(null);
      expect(group.visible).toBe(false);
      expect(fixture.owner.meshReservation()).toMatchObject({ displayCopyBytes: 24, gpuMeshBytes: 24, cleanupPending: true });
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(release).not.toHaveBeenCalled();
      fixture.owner.retire();
      expect(fixture.owner.returnResources()).toBe(true);
      expect(fixture.owner.returnResources()).toBe(true);
      expect(returned).toHaveBeenCalledTimes(3);
      expect(release).toHaveBeenCalledTimes(1);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
    } finally { await fixture.close(); }
  });

  it.each([1, 2])('rejects a provider reply at observation %s after retirement', async phase => {
    const fixture = await previewOwner();
    let resume!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const observed = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    fixture.setDelay(() => { calls++; if (calls === phase) { entered(); return waiting; } return Promise.resolve(); });
    try {
      const pending = fixture.owner.setReferenceRepairPreview(fixture.hover());
      await observed;
      fixture.owner.retire();
      expect(fixture.owner.returnResources()).toBe(true);
      resume(); await pending;
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.ui.pending()).toBe(0);
      expect(fixture.scope.current).toBe(true);
      expect(fixture.observations()).toBe(phase);
      expect(fixture.observation.snapshot().events.some(event => event.kind === 'publish-complete')).toBe(false);
    } finally { resume(); await fixture.close(); }
  });

  it('invalidates an already published proof before it can be rendered again', async () => {
    const fixture = await previewOwner();
    try {
      await fixture.owner.setReferenceRepairPreview(fixture.hover());
      expect(fixture.owner.ensureCurrent()).toBe(true);
      fixture.invalidate();
      expect(fixture.owner.ensureCurrent()).toBe(false);
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.owner.meshReservation().displayCopyBytes).toBe(0);
    } finally { await fixture.close(); }
  });

  it.each(['cancel', 'generation'] as const)('rejects late publication after %s without returning the borrowed Source', async mode => {
    const fixture = await previewOwner();
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    fixture.setDelay(() => waiting);
    try {
      const pending = fixture.owner.setReferenceRepairPreview(fixture.hover());
      expect(fixture.observations()).toBe(1);
      if (mode === 'cancel') {
        cancelReferenceRepair(fixture.session);
        void fixture.owner.setReferenceRepairPreview(null);
      } else fixture.replaceState({ ...useAppStore.getState(), requestedGeneration: 8, completedGeneration: 8 });
      resume(); await pending;
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
      expect(fixture.observations()).toBe(1);
      expect(fixture.observation.snapshot().events.some(event => event.kind === 'publish-complete')).toBe(false);
    } finally { resume(); await fixture.close(); }
  });

  it('serializes provider work and publishes only the newest request', async () => {
    const fixture = await previewOwner();
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    fixture.setDelay(() => fixture.observations() === 1 ? waiting : Promise.resolve());
    try {
      const first = fixture.owner.setReferenceRepairPreview(fixture.hover());
      const latest = fixture.hover();
      const second = fixture.owner.setReferenceRepairPreview(latest);
      expect(second).toBe(first);
      expect(fixture.observations()).toBe(1);
      resume(); await first; await second;
      expect(fixture.observations()).toBe(3);
      const published = fixture.observation.snapshot().events.filter(event => event.kind === 'publish-complete');
      expect(published).toHaveLength(1);
      expect(published[0].operationId).toMatch(new RegExp(`^repair-preview-operation-${latest.operationId}:\\d+$`, 'u'));
      const cycle = fixture.observation.snapshot().events.filter(event => event.operationId === published[0].operationId);
      expect(cycle.map(event => event.kind)).toEqual(['build-start', 'build-complete', 'publish-start', 'publish-complete']);
      expect(cycle.every(event => event.publicationId === published[0].publicationId
        && event.resourceOwnerId === published[0].resourceOwnerId)).toBe(true);
      expect(fixture.scene.children).toHaveLength(1);
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(fixture.scope.current).toBe(true);
    } finally { resume(); await fixture.close(); }
  });

  it('gives republished resources and an intervening failed allocation independent exactly-once returns', async () => {
    const f = await previewOwner();
    try {
      const descriptor = f.hover(), source = useAppStore.getState();
      const reserve = vi.spyOn(f.gpu, 'reserve'), release = vi.spyOn(f.gpu, 'release');
      await f.owner.setReferenceRepairPreview(descriptor);
      const first = overlayGeometry(f.scene), firstReturned = vi.fn();
      first.addEventListener('dispose', firstReturned);
      // The source is still current. A newly adopted, uninspected backing expires only this proof.
      f.ui.adopt([new ArrayBuffer(8)]);
      expect(f.owner.ensureCurrent()).toBe(false);
      expect(firstReturned).toHaveBeenCalledTimes(1);
      expect(f.gpu.reservedBytes()).toBe(0);

      fault.build = 'after';
      await f.owner.setReferenceRepairPreview(descriptor);
      expect(f.scene.children).toHaveLength(0);
      expect(f.ui.pending()).toBe(0);
      expect(f.gpu.reservedBytes()).toBe(0);
      fault.build = null;

      await f.owner.setReferenceRepairPreview(descriptor);
      const second = overlayGeometry(f.scene), secondReturned = vi.fn();
      second.addEventListener('dispose', secondReturned);
      expect(second).not.toBe(first);
      await f.owner.setReferenceRepairPreview(null);
      f.owner.retire(); expect(f.owner.returnResources()).toBe(true);
      expect(firstReturned).toHaveBeenCalledTimes(1);
      expect(secondReturned).toHaveBeenCalledTimes(1);
      expect(reserve).toHaveBeenCalledTimes(2);
      const gpuOwners = reserve.mock.calls.map(([owner]) => owner);
      expect(new Set(gpuOwners).size).toBe(2);
      expect(release.mock.calls.map(([owner]) => owner)).toEqual(gpuOwners);
      expect(f.gpu.reservedBytes()).toBe(0);
      expect(f.ui.pending()).toBe(0);
      expect(f.owner.meshReservation()).toMatchObject({ displayCopyBytes: 0, gpuMeshBytes: 0, cleanupPending: false });
      expect(f.scope.current).toBe(true);
      expect(useAppStore.getState().document).toBe(source.document);
      expect(useAppStore.getState().undoStack).toBe(source.undoStack);

      const snapshot = f.observation.snapshot(), events = snapshot.events.filter(event => event.preview);
      const starts = events.filter(event => event.kind === 'build-start');
      expect(starts).toHaveLength(3);
      expect(new Set(starts.map(event => event.operationId)).size).toBe(3);
      expect(new Set(starts.map(event => event.resourceOwnerId)).size).toBe(3);
      expect(new Set(starts.map(event => event.publicationId)).size).toBe(3);
      for (const start of starts) {
        const cycle = events.filter(event => event.operationId === start.operationId);
        expect(cycle.every(event => event.resourceOwnerId === start.resourceOwnerId
          && event.publicationId === start.publicationId && event.viewportOwnerId === 'repair-boundary')).toBe(true);
        const published = cycle.some(event => event.kind === 'publish-complete');
        expect(cycle.filter(event => event.kind === (published ? 'release-start' : 'candidate-return-start'))).toHaveLength(1);
        expect(cycle.filter(event => event.kind === (published ? 'release-complete' : 'candidate-return-complete'))).toHaveLength(1);
        expect(cycle.filter(event => event.kind === 'release-complete' || event.kind === 'candidate-return-complete')).toHaveLength(1);
      }
      expect(events.filter(event => event.kind === 'operation-aborted')).toHaveLength(1);
      expect(snapshot).toMatchObject({ duplicateTerminals: 0, unfinishedOwners: 0, missingStarts: 0, livePublications: 0 });
    } finally { await f.close(); }
  });

  it('keeps actual ownership and retryable returns intact when the observer throws', async () => {
    const fixture = await previewOwner();
    try {
      const record = vi.spyOn(fixture.observation, 'record').mockImplementation(() => { throw new Error('diagnostic sink failed'); });
      await expect(fixture.owner.setReferenceRepairPreview(fixture.hover())).resolves.toBeUndefined();
      expect(fixture.scene.children).toHaveLength(1);
      expect(fixture.gpu.reservedBytes()).toBe(24);
      const geometry = overlayGeometry(fixture.scene);
      const returned = vi.spyOn(geometry, 'dispose').mockImplementationOnce(() => { throw new Error('native return failed'); });
      fixture.owner.retire();
      expect(fixture.owner.returnResources()).toBe(false);
      expect(fixture.owner.meshReservation().cleanupPending).toBe(true);
      expect(fixture.gpu.reservedBytes()).toBe(24);
      expect(fixture.owner.returnResources()).toBe(true);
      expect(fixture.owner.returnResources()).toBe(true);
      expect(returned).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalled();
      expect(fixture.scene.children).toHaveLength(0);
      expect(fixture.gpu.reservedBytes()).toBe(0);
      expect(fixture.scope.current).toBe(true);
    } finally { await fixture.close(); }
  });
});


