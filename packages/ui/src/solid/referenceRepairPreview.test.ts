import { createPrimitiveFeature, recomputePart, createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, type AssemblyDocument,
  type RigidPlacement, type KernelBridge, type SolidBody } from '@pointercad/model';
import { afterEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { repairFixture } from './referenceRepairFixture.js';
import { currentRepairSlots } from './referenceRepairContext.js';
import { beginReferenceRepair, hoverReferenceRepair, cancelReferenceRepair } from './referenceRepair.js';
import { beginReferenceRepairPreview, readReferenceRepairRejections, currentReferenceRepairPreview, borrowReferenceRepairPreview } from './referenceRepairPreview.js';
import type { AssemblyMeshOwnership } from '../viewport/assemblyMeshAdmission.js';

afterEach(resetTestStore);

/** A synthetic issued-provider contract fixture; native Source evidence is tested in model, not inferred here. */
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


async function controlledAssemblyRepairPreview() {
  const source = await controlledRepairPreviewSource(true), state = useAppStore.getState();
  const part = { ...source, document: source.fixture.document, hiddenOwner: source.owner,
    result: { ...source.result, referenceBodies: source.hiddenBodies } };
  try {
  if (part.result.cancelled || part.result.generation !== 7) throw new Error('Assembly fixture source-result generation stage failed');
  if (part.result.errors.some(error => error.featureId === part.body.featureId))
    throw new Error(`Assembly fixture source-body errors stage failed: ${JSON.stringify(part.result.errors)}`);
  if (!part.scope.current || part.scope.document !== part.document || part.scope.context.generation !== part.result.generation
    || !part.scope.referenceBodyCurrent(part.body) || !part.result.referenceBodies.includes(part.body))
    throw new Error('Assembly fixture exact source-scope/body claim stage failed');
  const reference = source.fixture.reference;
  const assembly: AssemblyDocument = { ...createAssemblyDocument('preview assembly'),
    components: [{ id: 'component-1', name: 'source', source: { kind: 'part', partRef: 'part-key' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: false, suppressed: false }],
    mates: [{ id: 'repair-mate', name: 'repair', kind: 'parallel', suppressed: false, flipped: false,
      a: { kind: 'subShape', componentId: 'component-1', ref: reference },
      b: { kind: 'origin', componentId: 'component-1', element: 'x' } }] };
  const placement: RigidPlacement = { position: [900_000_000, 0, 0], rotation: [0, 0, 0, 1] };
  const bodies = new Map([['part-key', part.result.bodies]]);
  let sourceCurrent = true;
  const ownership: AssemblyMeshOwnership = { document: assembly, library: state.assemblyLibrary,
    activeDocumentId: assembly.id, documentVersion: state.documentVersion + 1, generation: 7,
    outcome: 'success', timelineIndex: null, cancelRequestCount: state.cancelRequestCount, bodies,
    sources: new Map([['part-key', { document: part.document, attachments: undefined,
      result: part.result, bodies: part.result.bodies, layouts: [], displayOwner: null,
      hiddenOwners: [part.hiddenOwner], current: () => sourceCurrent && part.scope.current }]]),
    receipt: { status: 'unknown', observationId: 'old-view-receipt-not-reused', reason: 'old-observation' },
    backingInspection: { status: 'unknown', reason: 'old-observation' },
    backingInspectionCurrent: () => false, receiptCurrent: () => false,
    publicationCurrent: () => sourceCurrent, uiSnapshot: { epoch: 0, buffers: [] } };
  useAppStore.setState({ assembly, drawing: null, activeDocumentId: assembly.id, documentVersion: ownership.documentVersion,
    requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success', isComputing: false,
    recomputeCancelled: false, timelineIndex: null,
    assemblyView: { sourceDocument: assembly, bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(),
      meshOwnership: ownership, resolved: { parts: new Map(), placements: new Map([['component-1', placement]]),
        partKeys: new Map([['component-1', 'part-key']]), errors: [] } } });
  const published = useAppStore.getState();
  if (published.assembly !== assembly || published.assemblyView?.sourceDocument !== assembly
    || published.assemblyView.meshOwnership !== ownership || ownership.library !== published.assemblyLibrary
    || published.activeDocumentId !== assembly.id || published.documentVersion !== ownership.documentVersion
    || published.requestedGeneration !== 7 || published.completedGeneration !== 7
    || published.isComputing || !part.scope.current) throw new Error('Assembly fixture published owner/context stage failed');
  const slot = currentRepairSlots(published).find(item => item.ownerId === 'repair-mate');
  if (slot === undefined || slot.componentId !== 'component-1' || slot.reference !== reference)
    throw new Error('Assembly fixture exact repair-slot/reference stage failed');
  if (slot.bodies.length !== 1 || slot.bodies[0] !== part.body)
    throw new Error(`Assembly fixture admitted source-body stage failed: ${slot.bodies.map(body => body.featureId).join(',')}`);
  const session = beginReferenceRepair(slot.key);
  if (session === null) throw new Error('Assembly fixture ready session stage failed');
  if (session.candidates.length !== 2) throw new Error(`Assembly fixture exact two-candidate stage failed: ${session.candidates.length}`);
  const hover = () => {
    expect(hoverReferenceRepair(session, session.candidates[0])).toBe(true);
    const descriptor = currentReferenceRepairPreview(useAppStore.getState());
    if (descriptor === null) throw new Error('Issued current Assembly preview required');
    return descriptor;
  };
  return { ...part, assembly, placement, ownership, session, hover,
    invalidateSource: () => { sourceCurrent = false; },
    close: async () => {
      try { cancelReferenceRepair(session); await part.scope.close(); }
      finally { try { part.bridge.dispose(); } finally { resetTestStore(); } }
    } };
  } catch (error) {
    try { await part.scope.close(); }
    finally { try { part.bridge.dispose(); } finally { resetTestStore(); } }
    throw error;
  }
}


describe('nonstored repair preview issued metadata and exact borrow', () => {
  it('borrows the actual hidden Assembly source and placement, observes afresh, and rejects source retirement', async () => {
    const fixture = await controlledAssemblyRepairPreview();
    try {
      const descriptor = fixture.hover(), borrowed = borrowReferenceRepairPreview(descriptor, useAppStore.getState());
      expect(borrowed?.body).toBe(fixture.body);
      expect(borrowed?.placement).toBe(fixture.placement);
      expect(borrowed?.additionalOwners).toEqual([fixture.hiddenOwner]);
      expect(fixture.ownership.receipt.status).toBe('unknown');
      if (borrowed === null) throw new Error('Current Source borrow required');
      const fresh = await borrowed.scope.capture('assembly-preview-fresh', borrowed.displayBodies, borrowed.additionalOwners);
      expect(fresh.status).toBe('known'); // The old View receipt is not used as publication evidence.
      fixture.invalidateSource();
      expect(currentReferenceRepairPreview(useAppStore.getState())).toBeNull();
      expect(currentRepairSlots(useAppStore.getState()).find(slot => slot.ownerId === 'repair-mate')?.bodies).toEqual([]);
      expect(fixture.scope.current).toBe(true);
    } finally { await fixture.close(); }
  });

  it('borrows the actual hidden Source without changing saved data, selection or history', async () => {
    const fixture = await controlledRepairPreview();
    try {
      const before = useAppStore.getState(), json = JSON.stringify(before.document);
      const descriptor = fixture.hover();
      expect(Object.keys(descriptor).sort()).toEqual(['componentId', 'documentId', 'elementId', 'generation', 'hoverId', 'operationId']);
      const borrowed = borrowReferenceRepairPreview(descriptor, useAppStore.getState());
      expect(borrowed?.body).toBe(fixture.body);
      expect(borrowed?.scope).toBe(fixture.scope);
      expect(borrowed?.displayBodies).toBe(fixture.displayBodies);
      expect(borrowReferenceRepairPreview({ ...descriptor }, useAppStore.getState())).toBeNull();
      const after = useAppStore.getState();
      expect(JSON.stringify(after.document)).toBe(json);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.selection).toBe(before.selection);
      const actualStrongBorrower = fixture.body.mesh.edgePositions;
      cancelReferenceRepair(fixture.session);
      expect(currentReferenceRepairPreview(useAppStore.getState())).toBeNull();
      expect(fixture.scope.current).toBe(true); // UI cancellation never releases the Source owner.
      expect(actualStrongBorrower.byteLength).toBeGreaterThan(0);
    } finally { await fixture.close(); }
  });

  it('old cancel cannot clear a newer simultaneous session on the same exact Part candidate id', async () => {
    const fixture = await controlledRepairPreview();
    try {
      const old = fixture.hover();
      const newer = beginReferenceRepair(fixture.session.slot.key);
      if (newer === null) throw new Error('Second current session required');
      expect(hoverReferenceRepair(newer, newer.candidates[0])).toBe(true);
      const descriptor = currentReferenceRepairPreview(useAppStore.getState());
      if (descriptor === null) throw new Error('Second issued preview required');
      expect(descriptor.hoverId).toBe(old.hoverId);
      expect(descriptor).not.toBe(old);
      cancelReferenceRepair(fixture.session);
      expect(useAppStore.getState().hoveredElementId).toBe(descriptor.hoverId);
      expect(currentReferenceRepairPreview(useAppStore.getState())).toBe(descriptor);
      expect(borrowReferenceRepairPreview(old, useAppStore.getState())).toBeNull();
      cancelReferenceRepair(newer);
      expect(currentReferenceRepairPreview(useAppStore.getState())).toBeNull();
    } finally { await fixture.close(); }
  });

  it.each(['generation', 'document-version', 'scope-close', 'detached-backing'] as const)('rejects %s rather than publishing an old borrow', async change => {
    const fixture = await controlledRepairPreview();
    try {
      const descriptor = fixture.hover(), state = useAppStore.getState();
      const changedState = change === 'generation' ? { ...state, requestedGeneration: 8, completedGeneration: 8 } : null;
      if (change === 'document-version') useAppStore.setState({ documentVersion: state.documentVersion + 1 });
      if (change === 'scope-close') await fixture.scope.close();
      if (change === 'detached-backing') {
        const buffer = fixture.body.mesh.edgePositions.buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Actual detachable backing required');
        structuredClone(buffer, { transfer: [buffer] });
      }
      expect(currentReferenceRepairPreview(changedState ?? useAppStore.getState())).toBeNull();
      expect(borrowReferenceRepairPreview(descriptor, changedState ?? useAppStore.getState())).toBeNull();
      expect(fixture.scope.current).toBe(change !== 'scope-close');
      if (change === 'generation') {
        useAppStore.setState({ requestedGeneration: 8, completedGeneration: 8 });
        expect(fixture.scope.current).toBe(false);
        expect(currentReferenceRepairPreview(useAppStore.getState())).toBeNull();
        expect(borrowReferenceRepairPreview(descriptor, useAppStore.getState())).toBeNull();
      }
    } finally { await fixture.close(); }
  });
});

it('copies bounded primitive rejection evidence without an additional provider observation', async () => {
  const fixture = await controlledAssemblyRepairPreview();
  try {
    const descriptor = fixture.hover();
    fixture.invalidateSource();
    const observations = fixture.observations();
    for (let index = 0; index < 70; index++) {
      beginReferenceRepairPreview(fixture.session, fixture.session.candidates[0], descriptor.hoverId, useAppStore.getState(), () => true);
      expect(borrowReferenceRepairPreview(descriptor, useAppStore.getState())).toBeNull();
    }
    const evidence = readReferenceRepairRejections();
    expect(evidence).toHaveLength(64);
    expect(evidence.every(entry => Object.keys(entry).join(',') === 'reason')).toBe(true);
    expect(evidence[evidence.length - 1]?.reason).toBe('borrow-assembly:11');
    expect(readReferenceRepairRejections()).not.toBe(evidence);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(fixture.observations()).toBe(observations);
  } finally { await fixture.close(); }
});
