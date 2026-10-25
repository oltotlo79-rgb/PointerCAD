import { startRefreshPartSource } from './replaceActions.js';
import { readDocumentBundle, writeDocumentBundle } from '@pointercad/io';
import { createPartDocumentBundle, replacePartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument,
  createStandardPartSource,
  embedPart, emptyEmbeddedPartAttachments, EMPTY_PART_LIBRARY, KERNEL_BROKEN_MESSAGE,
  applyPlacementToDirection, moveComponent, quaternionFromAxisAngle, removeComponent, resolvePart,
  partKeyOf,
  type AssemblyDocument, type AssemblyKernelBridge, type Mate, type PartDocument, type SolidBody, type Vec3,
} from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { createFakeRecompute } from '../store/testing/createTestStore.js';
import { attachAssembly, readAssemblyRecomputeGates, type AssemblyConstraintExecution } from './attachAssembly.js';
import { buildAssemblyGeometry } from '../viewport/createAssemblyLayer.js';
import { captureAssemblyMeshAdmission, currentAssemblyMeshAdmission } from '../viewport/assemblyMeshAdmission.js';
import { addMateTarget, commitMateDraft, startMate, updateMateSource } from './mateActions.js';
import { subShapeRefOf } from '../solid/subShapeSelection.js';
import { assemblyMateStatus } from '../shell/statusText.js';
import { beginComponentDrag, finishComponentDrag, moveComponentDrag } from './dragComponentActions.js';
import { componentDragPlane } from '../viewport/dragComponent.js';
import { resolveCurrentMateTarget } from './mateCommands.js';

beforeEach(resetTestStore);

function importedPart(): PartDocument {
  return { ...createEmptyPartDocument(), solids: [{ id: 'imported-1', name: 'STEP',
    kind: 'importedSolid', suppressed: false, shapeRef: 'shape-1', bodyKind: 'solid',
    source: { format: 'step', fileName: 'source.step', unit: 'mm', byteLength: 1 } }] };
}

async function fixture() {
  const a = await embedPart(EMPTY_PART_LIBRARY, importedPart(), 'a.pcad', 'a.pcad', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(10)]]) },
  });
  const b = await embedPart(a.library, importedPart(), 'b.pcad', 'b.pcad', {
    attachments: { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(20)]]) },
  });
  let document = createAssemblyDocument('assembly');
  for (const partRef of [a.partRef, b.partRef, a.partRef]) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
  }
  return { document, library: b.library, a: a.partRef, b: b.partRef };
}

function body(featureId: string, size: number): SolidBody {
  const box = new THREE.BoxGeometry(size, size, size);
  box.translate(size / 2, size / 2, size / 2);
  const edges = new THREE.EdgesGeometry(box);
  const directions: readonly Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  try {
    const indices = box.getIndex();
    if (indices === null) throw new Error('fixture');
    return { featureId, volume: size ** 3, isValid: true, edges: [], vertices: [], threadMarks: [],
      faces: directions.map((axis, index) => ({ index, surfaceKind: 'plane', area: size * size,
        centroid: [(axis[0] + 1) * size / 2, (axis[1] + 1) * size / 2, (axis[2] + 1) * size / 2],
        axis, radius: null, triangleOffset: index * 2, triangleCount: 2 })),
      mesh: { positions: new Float32Array(box.getAttribute('position').array), normals: new Float32Array(box.getAttribute('normal').array),
        indices: new Uint32Array(indices.array), edgePositions: new Float32Array(edges.getAttribute('position').array), triangleCount: 12 } };
  } finally { edges.dispose(); box.dispose(); }
}

function fakeBridge() {
  // Issued metadata fixture only. It exercises ASM ownership, not an actual Worker/OCCT receipt.
  type Owner = NonNullable<ReturnType<NonNullable<AssemblyKernelBridge['meshLedgerOwner']>>>;
  type Claim = NonNullable<ReturnType<NonNullable<AssemblyKernelBridge['capturePartReleaseClaim']>>>;
  type Receipt = Awaited<ReturnType<NonNullable<AssemblyKernelBridge['captureCurrentMeshLedger']>>>;
  type Inspection = Awaited<ReturnType<NonNullable<AssemblyKernelBridge['inspectSourceMeshBackings']>>>;
  const issued = new WeakMap<readonly SolidBody[], Owner>(), active = new Map<string, Owner>();
  const claims = new WeakSet<Claim>(), receipts = new WeakSet<object>(), retainedBuffers = new Set<ArrayBufferLike>();
  const inspections = new WeakMap<Inspection, Receipt>();
  let epoch = 0, dispatch = 0;
  const keys = new Set<string>();
  const releasePart = vi.fn<AssemblyKernelBridge['releasePart']>(() => Promise.resolve());
  const checkShapeAvailability = vi.fn<AssemblyKernelBridge['checkShapeAvailability']>((partId, requested) =>
    Promise.resolve({ partId, missingKeys: requested.filter((key) => !keys.has(key)) }));
  const recomputeSolids = vi.fn<AssemblyKernelBridge['recomputeSolids']>((steps, options) => {
    for (const step of steps) keys.add(step.key);
    const bodies = steps.filter(step => step.visible).map(step => body(step.featureId, step.plan.kind === 'importedSolid' ? step.plan.bytes[0] : 1));
    const owner: Owner = { dispatchId: `fixture-${++dispatch}`, partId: options?.partId ?? 'fixture',
      generation: options?.generation ?? 0, kind: 'display', steps: steps.map(step => ({ id: step.featureId, key: step.key })) };
    issued.set(bodies, owner); active.set(owner.partId, owner); epoch += 1;
    for (const entry of bodies) for (const array of [entry.mesh.positions, entry.mesh.normals, entry.mesh.indices, entry.mesh.edgePositions]) retainedBuffers.add(array.buffer);
    return Promise.resolve({ bodies,
    failures: [], cacheHits: 0, cancelled: false });
  });
  const bridge: AssemblyKernelBridge = {
    releasePart, checkShapeAvailability, recomputeSolids,
    meshLedgerOwner: bodies => issued.get(bodies) ?? null,
    capturePartReleaseClaim(bodies) {
      const owner = issued.get(bodies); if (owner === undefined) return null;
      const claim = Object.freeze({ owner, connectionEpoch: 1 }); claims.add(claim); return claim;
    },
    async releasePartClaim(claim) {
      if (!claims.has(claim)) return { status: 'unavailable', reason: 'fixture-unissued' };
      const owner = active.get(claim.owner.partId);
      if (owner === undefined) return { status: 'absent' };
      if (owner !== claim.owner) return { status: 'stale-owner' };
      await releasePart(claim.owner.partId); active.delete(claim.owner.partId); epoch += 1;
      return { status: 'released' };
    },
    releaseReferenceMeshLease: () => Promise.resolve({ released: true }),
    captureCurrentMeshLedger(input) {
      const bytes = [...retainedBuffers].reduce((sum, buffer) => sum + buffer.byteLength, 0);
      const receipt: Receipt = { status: 'known', observationId: input.observationId, hostEpoch: epoch,
        workerEpochs: [{ providerId: 1, connectionEpoch: 1, cache: epoch, owners: epoch }], owners: [...active.values()],
        limitBytes: 512 * 1024 * 1024, workerRetainedBackingBytes: 0, hostRetainedBackingBytes: bytes,
        pendingCloneReservedBytes: 0, admittedBoundBytes: bytes, coverage: 'registered-solid-mesh-backings-only',
        unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
      receipts.add(receipt); return Promise.resolve(receipt);
    },
    currentMeshLedgerReceipt: receipt => receipts.has(receipt) && receipt.status === 'known' && receipt.hostEpoch === epoch,
    inspectSourceMeshBackings(receipt, buffers) {
      if (!receipts.has(receipt) || receipt.status !== 'known' || receipt.hostEpoch !== epoch) {
        return Promise.resolve({ status: 'unknown', reason: 'fixture-stale-receipt' });
      }
      const validated: ArrayBuffer[] = [];
      for (const buffer of buffers) {
        if (!(buffer instanceof ArrayBuffer) || 'resizable' in buffer && buffer.resizable === true) {
          return Promise.resolve({ status: 'unknown', reason: 'fixture-unsupported-input-backing' });
        }
        try { new Uint8Array(buffer, 0, 0); }
        catch { return Promise.resolve({ status: 'unknown', reason: 'fixture-detached-input-backing' }); }
        validated.push(buffer);
      }
      const unique = [...new Set(validated)];
      const inspection: Inspection = { status: 'known', hostEpoch: epoch,
        inputBackingBytes: unique.reduce((sum, buffer) => sum + buffer.byteLength, 0),
        additionalBackingBytes: unique.filter(buffer => !retainedBuffers.has(buffer)).reduce((sum, buffer) => sum + buffer.byteLength, 0),
        sameSourceBackings: unique.filter(buffer => retainedBuffers.has(buffer)).map(buffer => new WeakRef(buffer)),
        coverage: 'registered-main-solid-backings-only', unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
      inspections.set(inspection, receipt); return Promise.resolve(inspection);
    },
    currentSourceMeshBackingInspection: (inspection, receipt) => inspections.get(inspection) === receipt
      && receipt.status === 'known' && receipt.hostEpoch === epoch,
    tessellateSketchFaces: () => Promise.resolve({ mesh: { faces: [] }, failures: [] }),
    offsetSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    projectSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    sectionSketchCurves: () => Promise.resolve({ results: [], failures: [] }),
    measure: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    exportShapes: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    importShape: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    inspectPrintability: () => Promise.resolve({ kind: 'failed', message: 'unused' }),
    dispose: () => undefined,
  };
  return { bridge, keys, recomputeSolids, releasePart, checkShapeAvailability,
    aliasFixtureBodies(source: readonly SolidBody[], replacement: readonly SolidBody[]) {
      const owner = issued.get(source); if (owner === undefined) throw new Error('Fixture source owner missing');
      issued.set(replacement, owner);
    } };
}

async function settle(): Promise<void> {
  await vi.waitFor(() => {
    const state = useAppStore.getState();
    expect(state.isComputing).toBe(false);
    expect(state.completedGeneration).toBe(state.requestedGeneration);
  });
}

function originMate(document: AssemblyDocument, kind: 'coincident' | 'distance', value?: number): Mate {
  return {
    id: 'mate-1', name: '合致1', kind,
    a: { kind: 'origin', componentId: document.components[0].id, element: 'origin' },
    b: { kind: 'origin', componentId: document.components[1].id, element: 'origin' },
    ...(value === undefined ? {} : { value: { ...expressionValueFromNumber(value),
      source: value === 20 ? '10*2' : String(value), display: value === 20 ? '10*2' : String(value) } }),
    flipped: false, suppressed: false,
  };
}

describe('fake membership provider actual backing validation (metadata only)', () => {
  it('accepts attached ArrayBuffers including zero-byte input and deduplicates exact identities', async () => {
    const fake = fakeBridge(), capture = fake.bridge.captureCurrentMeshLedger?.bind(fake.bridge);
    const inspect = fake.bridge.inspectSourceMeshBackings?.bind(fake.bridge);
    if (capture === undefined || inspect === undefined) throw new Error('Fixture membership provider missing');
    const receipt = await capture({ observationId: 'fixture-attached', owners: [] });
    const attached = new ArrayBuffer(32), empty = new ArrayBuffer(0);
    expect(() => new Uint8Array(empty, 0, 0)).not.toThrow();
    const reading = await inspect(receipt, [attached, attached, empty]);
    expect(reading).toMatchObject({ status: 'known', inputBackingBytes: 32, additionalBackingBytes: 32,
      sameSourceBackings: [], coverage: 'registered-main-solid-backings-only' });
    expect(fake.bridge.currentSourceMeshBackingInspection?.(reading, receipt)).toBe(true);
    expect(attached.byteLength).toBe(32);
  });

  it('rejects actual SharedArrayBuffer input as unknown without issuing membership evidence', async () => {
    const fake = fakeBridge(), capture = fake.bridge.captureCurrentMeshLedger?.bind(fake.bridge);
    const inspect = fake.bridge.inspectSourceMeshBackings?.bind(fake.bridge);
    if (capture === undefined || inspect === undefined) throw new Error('Fixture membership provider missing');
    const receipt = await capture({ observationId: 'fixture-shared', owners: [] });
    const shared = new SharedArrayBuffer(32);
    const reading = await inspect(receipt, [new ArrayBuffer(8), shared]);
    expect(reading).toEqual({ status: 'unknown', reason: 'fixture-unsupported-input-backing' });
    expect(fake.bridge.currentSourceMeshBackingInspection?.(reading, receipt)).toBe(false);
    expect(shared.byteLength).toBe(32);
  });

  it('rejects an actually transferred detached ArrayBuffer while preserving the attached transfer result', async () => {
    const fake = fakeBridge(), capture = fake.bridge.captureCurrentMeshLedger?.bind(fake.bridge);
    const inspect = fake.bridge.inspectSourceMeshBackings?.bind(fake.bridge);
    if (capture === undefined || inspect === undefined) throw new Error('Fixture membership provider missing');
    const receipt = await capture({ observationId: 'fixture-detached', owners: [] });
    const detached = new ArrayBuffer(32);
    const transferred = structuredClone(detached, { transfer: [detached] });
    expect(detached.byteLength).toBe(0);
    expect(() => new Uint8Array(detached, 0, 0)).toThrow();
    const reading = await inspect(receipt, [new ArrayBuffer(8), detached]);
    expect(reading).toEqual({ status: 'unknown', reason: 'fixture-detached-input-backing' });
    expect(fake.bridge.currentSourceMeshBackingInspection?.(reading, receipt)).toBe(false);
    expect(transferred.byteLength).toBe(32);
    expect(await inspect(receipt, [transferred])).toMatchObject({ status: 'known', inputBackingBytes: 32,
      additionalBackingBytes: 32, sameSourceBackings: [] });
  });
});

describe('アセンブリの実経路', () => {
  it('forwards the same bounded local mesh request for actual model dispatch and replacement', async () => {
    const f = await fixture(), fake = fakeBridge();
    // Issued ownership metadata fixture; this is not native/GPU precision evidence.
    const original = fake.recomputeSolids.getMockImplementation();
    if (original === undefined) throw new Error('Missing fixture implementation');
    fake.recomputeSolids.mockImplementation(async (steps, options) => {
      const local = options?.localMesh;
      if (local === undefined || options?.partId === undefined) throw new Error('Missing bounded local request');
      const result = await original(steps, options);
      const bodies = result.bodies.map(body => ({ ...body, coordinateFrame: {
        space: 'local' as const, origin: [1e9, 0, 0] as const, ...local,
      } }));
      fake.aliasFixtureBodies(result.bodies, bodies);
      const bytes = bodies.reduce((sum, body) => sum + body.mesh.positions.byteLength + body.mesh.normals.byteLength
        + body.mesh.indices.byteLength + body.mesh.edgePositions.byteLength, 0);
      return { ...result, bodies, meshJsAccounting: { partId: options.partId, generation: options.generation ?? 0,
        reading: { status: 'known' as const, limitBytes: local.maximumLiveMeshBytes, cacheActiveBytes: 0,
          cacheRetiredBytes: 0, cacheProtectedBytes: 0, retainedReplyBytes: bytes, requestPeakReservedBytes: bytes * 2 },
        final: { status: 'known' as const, limitBytes: local.maximumLiveMeshBytes, cacheActiveBytes: 0,
          cacheRetiredBytes: 0, cacheProtectedBytes: 0, displayBackingBytes: bytes, replyBackingBytes: bytes,
          retainedBackingBytes: bytes, replyCloneReservedBytes: bytes } } };
    });
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const generation = useAppStore.getState().completedGeneration;
      expect(fake.recomputeSolids.mock.calls).toHaveLength(2);
      for (const [, options] of fake.recomputeSolids.mock.calls) {
        expect(options?.localMesh).toEqual({ maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 });
        expect(options?.generation).toBe(generation);
        expect(options?.shouldCancel?.()).toBe(false);
      }
      expect(fake.recomputeSolids.mock.calls.map(([, options]) => options?.partId)).toEqual([f.a, f.b]);
      const state = useAppStore.getState(), view = state.assemblyView;
      if (view === null) throw new Error('Missing assembly view');
      const bundle = buildAssemblyGeometry({ sourceDocument: f.document, components: f.document.components,
        bodies: view.bodies, placements: view.resolved.placements, partKeys: view.resolved.partKeys,
        hoveredComponentId: null, selectedComponentIds: [] });
      const admission = captureAssemblyMeshAdmission(bundle, state);
      expect(admission).not.toBeNull();
      if (admission === null) throw new Error('Missing local source admission');
      expect(currentAssemblyMeshAdmission(admission, { ...state, requestedGeneration: generation + 1 })).toBe(false);
      expect(currentAssemblyMeshAdmission(admission, { ...state, cancelRequestCount: state.cancelRequestCount + 1 })).toBe(false);
      for (const source of admission.ownership.sources.values()) {
        expect(source.result.meshJsAccounting?.generation).toBe(source.result.generation);
        expect(source.result.meshJsAccounting?.documentId).toBe(source.document.id);
        expect(source.bodies[0].coordinateFrame?.origin).toEqual([1e9, 0, 0]);
      }
      const runner = useAppStore.getState().assemblyReplacementRunner;
      if (runner === null) throw new Error('Missing replacement runner');
      const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['shape-1', Uint8Array.of(30)]]) };
      const bodies = await runner.resolve(importedPart(), attachments, 'local-request');
      expect(bodies[0].volume).toBe(27000);
      const replacement = fake.recomputeSolids.mock.calls.at(-1)?.[1];
      expect(replacement?.partId).toBe('replacement:local-request');
      expect(replacement?.localMesh).toEqual({ maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 });
      expect(fake.releasePart).toHaveBeenCalledWith('replacement:local-request');
      expect(replacement?.shouldCancel?.()).toBe(false);
    } finally { detach(); }
  });

  it('all cache hits obtain a fresh ledger while unchanged source Part generations stay unchanged', async () => {
    const f = await fixture(), fake = fakeBridge();
    const capture = vi.spyOn(fake.bridge, 'captureCurrentMeshLedger');
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const before = useAppStore.getState().assemblyView?.meshOwnership;
      if (before === undefined) throw new Error('First current publication');
      const sourceGenerations = [...before.sources.values()].map(source => source.result.generation);
      const newDocument = { ...f.document };
      useAppStore.getState().applyAssembly(newDocument); await settle();
      const after = useAppStore.getState().assemblyView?.meshOwnership;
      if (after === undefined) throw new Error('Second current publication');
      expect(after.document).toBe(newDocument); expect(after.generation).toBeGreaterThan(before.generation);
      expect([...after.sources.values()].map(source => source.result.generation)).toEqual(sourceGenerations);
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(2); expect(capture).toHaveBeenCalledTimes(2);
      expect(after.receipt).not.toBe(before.receipt); expect(after.publicationCurrent()).toBe(true);
      useAppStore.setState({ requestedGeneration: after.generation + 1 });
      expect(after.publicationCurrent()).toBe(false);
    } finally { detach(); }
  });

  it('130 source replacements close actual Scope objects without recomputing the unrelated source', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge), closes: { readonly mock: { readonly calls: unknown[][] } }[] = [];
    try {
      await settle();
      const otherGeneration = useAppStore.getState().assemblyView?.meshOwnership?.sources.get(f.b)?.result.generation;
      for (let index = 0; index < 130; index++) {
        const current = useAppStore.getState(), source = current.assemblyView?.meshOwnership?.sources.get(f.a);
        const part = current.assemblyLibrary.parts.get(f.a);
        if (source?.result.referenceMeshScope === undefined || part === undefined) throw new Error('Actual current Scope fixture');
        const close = vi.spyOn(source.result.referenceMeshScope, 'close'); closes.push(close);
        useAppStore.setState({ assemblyLibrary: { ...current.assemblyLibrary, parts: new Map(current.assemblyLibrary.parts).set(f.a, { ...part }) } });
        await settle(); expect(close).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState().assemblyView?.meshOwnership?.sources.get(f.b)?.result.generation).toBe(otherGeneration);
      }
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(132); expect(fake.releasePart).toHaveBeenCalledTimes(130);
      expect(closes.every(close => close.mock.calls.length === 1)).toBe(true);
      // This is actual Scope-object lifecycle with metadata fixtures, not a 128 actual hidden-lease measurement.
    } finally { detach(); }
  }, 20000);

  it('failed Scope return stays reachable after one detach and retries without repeating successful Part return', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge); await settle();
    const scope = useAppStore.getState().assemblyView?.meshOwnership?.sources.get(f.a)?.result.referenceMeshScope;
    if (scope === undefined) throw new Error('Actual current Scope fixture');
    const close = vi.spyOn(scope, 'close').mockResolvedValueOnce(false);
    detach();
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
    expect(fake.releasePart.mock.calls.filter(([ref]) => ref === f.a)).toHaveLength(1);
  });

  it('publishes its first view with the actual completed request generation and outcome', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const published: { requested: number; completed: number; outcome: string | null }[] = [];
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.assemblyView !== null && next.assemblyView !== previous.assemblyView) {
        published.push({ requested: next.requestedGeneration, completed: next.completedGeneration, outcome: next.lastOutcome });
      }
    });
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      expect(published).toHaveLength(1);
      expect(published[0].requested).toBeGreaterThan(0);
      expect(published[0].completed).toBe(published[0].requested);
      expect(published[0].outcome).toBe('success');
    } finally { unsubscribe(); detach(); }
  });

  it('曖昧な保存参照は自動合致と現在対象の両入口で断り、元文書を保持する', async () => {
    const f = await fixture(), current = body('imported-1', 10), top = current.faces[4];
    const ref = subShapeRefOf([current], 'imported-1#face:4');
    if (ref === null) throw new Error('fixture reference');
    const target = { kind: 'subShape' as const, componentId: f.document.components[0].id, ref: { ...ref, index: 99 } };
    const document: AssemblyDocument = { ...f.document, mates: [{ id: 'mate-ambiguous', name: 'parallel', kind: 'parallel',
      a: target, b: { kind: 'origin', componentId: f.document.components[1].id, element: 'xy' }, flipped: false, suppressed: false }] };
    const saved = JSON.stringify(document), fake = fakeBridge(), original = fake.recomputeSolids.getMockImplementation();
    if (original === undefined) throw new Error('fixture recompute');
    fake.recomputeSolids.mockImplementation(async (steps, options) => {
      const result = await original(steps, options);
      const bodies = result.bodies.map(candidate => ({ ...candidate, faces: [{ ...top, index: 7 }, { ...top, index: 19 }] }));
      fake.aliasFixtureBodies(result.bodies, bodies);
      return { ...result, bodies };
    });
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const view = useAppStore.getState().assemblyView;
      if (view == null) throw new Error('assembly view');
      expect(view.mateTargetErrors.get('mate-ambiguous')?.length).toBeGreaterThan(0);
      expect(resolveCurrentMateTarget(document, view, target).ok).toBe(false);
      const uniqueView = { ...view, bodies: new Map(view.bodies).set(f.a, [{ ...current, faces: [{ ...top, index: 7 }] }]) };
      expect(resolveCurrentMateTarget(document, uniqueView, target).ok).toBe(true);
      expect(JSON.stringify(useAppStore.getState().assembly)).toBe(saved);
      expect(JSON.stringify(document)).toBe(saved);
    } finally { detach(); }
  });

  it('寸法表から組んだ規格部品を通常部品と同じ橋で再計算して表示する', async () => {
    let document = createAssemblyDocument('規格部品');
    const source = createStandardPartSource('hexBolt', 'M8', { length: '30' });
    document = addComponent(document, createComponentFor(document, source));
    useAppStore.getState().openAssembly(document);
    const fake = fakeBridge();
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const key = partKeyOf(source);
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(1);
      expect(fake.recomputeSolids.mock.calls[0][1]?.partId).toBe(key);
      expect(useAppStore.getState().assemblyView?.bodies.has(key)).toBe(true);
      expect(useAppStore.getState().assemblyView?.resolved.partKeys.get('component-1')).toBe(key);
      expect(useAppStore.getState().assemblyView?.resolved.errors).toEqual([]);
      expect(useAppStore.getState().lastOutcome).toBe('success');
    } finally {
      detach();
    }
  });

  it.each([0, 5, -5])('実部分形状と実solverで20mm箱の面offset %sを解き、Undo/Redoも解き直す', async (offset) => {
    const f = await fixture();
    let document = createAssemblyDocument('箱');
    for (let index = 0; index < 2; index += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: f.b }));
    document = moveComponent(document, 'component-2', { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(50)], rotation: [0, 0, 0, 1] });
    useAppStore.getState().openAssembly(document, f.library);
    const bridge = fakeBridge();
    const detach = attachAssembly(bridge.bridge);
    try {
      await settle(); startMate('coincident');
      for (const [componentId, index] of [['component-1', 4], ['component-2', 5]] as const) {
        const ref = subShapeRefOf([body('imported-1', 20)], `imported-1#face:${index}`);
        if (ref === null) throw new Error('fixture');
        expect(addMateTarget({ kind: 'subShape', componentId, ref })).toBe(true);
      }
      updateMateSource(String(offset));
      expect(commitMateDraft()?.ok).toBe(true); await settle();
      const check = () => {
        const state = useAppStore.getState();
        expect(state.assemblyView?.diagnosis?.converged, JSON.stringify({ diagnosis: state.assemblyView?.diagnosis, mates: state.assembly?.mates })).toBe(true);
        expect(state.assemblyView?.resolved.placements.get('component-2')?.position[2]).toBeCloseTo(20 + offset, 9);
        expect(state.assemblyView?.resolved.placements.get('component-1')?.position).toEqual([0, 0, 0]);
        expect(state.assembly?.components[1].placement.position[2].value).toBe(50);
      };
      check(); expect(bridge.recomputeSolids).toHaveBeenCalledTimes(1);
      useAppStore.getState().undo(); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')?.position[2]).toBe(50);
      useAppStore.getState().redo(); await settle(); check();
      const stable = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      useAppStore.setState((state) => ({ documentVersion: state.documentVersion + 1 })); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')).toEqual(stable);
    } finally { detach(); }
  });

  it.each([4, 5])('初期の面index=%sでも実solverの既定が向かい合わせになる', async (faceIndex) => {
    const f = await fixture();
    let document = createAssemblyDocument('箱');
    for (let i = 0; i < 2; i += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: f.b }));
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      for (const [componentId, index] of [['component-1', 4], ['component-2', faceIndex]] as const) {
        const ref = subShapeRefOf([body('imported-1', 20)], `imported-1#face:${index}`);
        if (ref === null) throw new Error('fixture');
        addMateTarget({ kind: 'subShape', componentId, ref });
      }
      expect(useAppStore.getState().assemblyMateDraft?.flipped).toBe(faceIndex === 4);
      commitMateDraft(); await settle();
      const placement = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      if (placement === undefined) throw new Error('placement');
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
      const direction = applyPlacementToDirection(placement, [0, 0, faceIndex === 4 ? 1 : -1]);
      expect(direction[2]).toBeCloseTo(-1, 9);
    } finally { detach(); }
  });

  it('角度の90度既定を45度の基準軸から実solverで解く', async () => {
    const f = await fixture();
    const document = moveComponent(f.document, 'component-2', { ...f.document.components[1].placement,
      rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 4) });
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle(); startMate('angle');
      for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'x' });
      expect(commitMateDraft()).toMatchObject({ ok: true, mate: { value: { value: 90 } } });
      await settle();
      const placement = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      if (placement === undefined) throw new Error('placement');
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
      expect(applyPlacementToDirection(placement, [1, 0, 0])[0]).toBeCloseTo(0, 9);
    } finally { detach(); }
  });

  it('平行軸から90度の零微分は実solverの停止理由を示し、last-goodを保つ', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      const before = useAppStore.getState().assemblyView?.resolved.placements.get('component-2');
      startMate('angle');
      for (const componentId of ['component-1', 'component-2']) addMateTarget({ kind: 'origin', componentId, element: 'x' });
      expect(commitMateDraft()?.ok).toBe(true);
      await settle();
      const view = useAppStore.getState().assemblyView;
      expect(view?.diagnosis?.status).toBe('stalled');
      expect(view?.diagnosis?.provenConflictMateIds).toEqual([]);
      expect(view?.resolved.placements.get('component-2')).toEqual(before);
      expect(assemblyMateStatus(null, view?.diagnosis ?? null, new Map())?.text).toContain('計算が進まなく');
      expect(useAppStore.getState().lastOutcome).toBe('failed');
    } finally { detach(); }
  });

  it('独立成分の部分成功を採用し、失敗成分だけ保持して修正後に更新する', async () => {
    const f = await fixture();
    let document = createAssemblyDocument('独立した組');
    for (let i = 0; i < 4; i += 1) {
      const component = createComponentFor(document, { kind: 'part', partRef: f.b });
      document = addComponent(document, component);
      document = moveComponent(document, component.id, { position: [expressionValueFromNumber(i * 12), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] });
    }
    const origin = (componentId: string) => ({ kind: 'origin', componentId, element: 'origin' } as const);
    const distance = (id: string, value: number): Mate => ({ id, name: id, kind: 'distance', a: origin('component-3'), b: origin('component-4'), flipped: false, suppressed: false, value: expressionValueFromNumber(value) });
    const mates = [originMate(document, 'coincident'), distance('mate-2', 10), distance('mate-3', 20)];
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle(); useAppStore.getState().applyAssembly({ ...document, mates }); await settle();
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(false);
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')?.position[0]).toBeCloseTo(0, 9);
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-4')?.position[0]).toBe(36);
      const movedFixed = moveComponent({ ...document, mates }, 'component-1', { position: [expressionValueFromNumber(100), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] });
      useAppStore.getState().applyAssembly(movedFixed); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-1')?.position[0]).toBe(100);
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-2')?.position[0]).toBeCloseTo(100, 9);
      useAppStore.getState().applyAssembly({ ...document, mates: mates.slice(0, 2) }); await settle();
      expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
      const placements = useAppStore.getState().assemblyView?.resolved.placements;
      expect(Math.abs((placements?.get('component-4')?.position[0] ?? 0) - (placements?.get('component-3')?.position[0] ?? 0))).toBeCloseTo(10, 9);
      // 削除要求の計算が上書きされても、再追加された同じIDへ過去の解を戻さない。
      useAppStore.getState().applyAssembly(removeComponent({ ...document, mates: mates.slice(0, 2) }, 'component-4'));
      useAppStore.getState().applyAssembly({ ...document, mates }); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-4')?.position[0]).toBe(36);
      // 同じIDでも別文書の初回失敗は前の成功姿勢を引き継がない。
      useAppStore.getState().closeAssembly();
      useAppStore.getState().openAssembly({ ...document, mates }, f.library); await settle();
      expect(useAppStore.getState().assemblyView?.resolved.placements.get('component-4')?.position[0]).toBe(36);
    } finally { detach(); }
  });

  it('既に消失した面を追加しても確定前に拒否し、文書と履歴を変えない', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle(); startMate('coincident');
      const ref = subShapeRefOf([body('gone', 20)], 'gone#face:4');
      if (ref === null) throw new Error('fixture');
      expect(addMateTarget({ kind: 'subShape', componentId: 'component-1', ref })).toBe(false);
      expect(useAppStore.getState().assemblyMateDraft?.issue).toBeTruthy();
      const before = useAppStore.getState();
      expect(commitMateDraft()?.ok).toBe(false);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
    } finally { detach(); }
  });
  it('原点一致を実solveMatesで解き、解だけをAssemblyViewへ置く', async () => {
    const f = await fixture();
    const moved = moveComponent(f.document, f.document.components[1].id, {
      position: [expressionValueFromNumber(12), expressionValueFromNumber(0), expressionValueFromNumber(0)],
      rotation: [0, 0, 0, 1],
    });
    const document = { ...moved, mates: [originMate(moved, 'coincident')] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    await settle();
    expect(useAppStore.getState().assemblyView?.resolved.placements.get(document.components[1].id)?.position[0]).toBeCloseTo(0, 9);
    expect(useAppStore.getState().assemblyView?.diagnosis?.converged).toBe(true);
    expect(useAppStore.getState().assembly?.components[1].placement.position[0].value).toBe(12);
    detach();
  });

  it('距離式10*2を実solverで20mmへ解き、式は文書へ残す', async () => {
    const f = await fixture();
    const moved = moveComponent(f.document, f.document.components[1].id, {
      position: [expressionValueFromNumber(5), expressionValueFromNumber(0), expressionValueFromNumber(0)],
      rotation: [0, 0, 0, 1],
    });
    const document = { ...moved, mates: [originMate(moved, 'distance', 20)] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    await settle();
    const position = useAppStore.getState().assemblyView?.resolved.placements.get(document.components[1].id)?.position;
    expect(Math.abs(position?.[0] ?? 0)).toBeCloseTo(20, 9);
    expect(useAppStore.getState().assembly?.mates[0].value).toMatchObject({ source: '10*2', value: 20 });
    detach();
  });

  it('合致だけの変更は部品形を再計算せず、実診断を更新する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    useAppStore.getState().applyAssembly({ ...f.document, mates: [originMate(f.document, 'coincident')] });
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().assemblyView?.diagnosis).not.toBeNull();
    detach();
  });

  it('対象が欠けた合致を消さず、理由とDOF不明を返す', async () => {
    const f = await fixture();
    const mate = { ...originMate(f.document, 'coincident'),
      b: { kind: 'origin', componentId: 'missing', element: 'origin' } as const };
    const document = { ...f.document, mates: [mate] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    await settle();
    expect(useAppStore.getState().assemblyView?.mateTargetErrors.get('mate-1')).toHaveLength(1);
    expect(useAppStore.getState().assembly?.mates).toHaveLength(1);
    expect(useAppStore.getState().assemblyView?.diagnosis?.complete).toBe(false);
    detach();
  });
  it('別 STEP 2 種・同一部品 2 個を1つの橋で解決し、鍵と寸法が混ざらない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(fake.recomputeSolids.mock.calls.map((call) => call[1]?.partId)).toEqual([f.a, f.b]);
    expect(fake.recomputeSolids.mock.calls[0][0][0].key).not.toBe(fake.recomputeSolids.mock.calls[1][0][0].key);
    const view = useAppStore.getState().assemblyView;
    expect(view?.bodies.get(f.a)?.[0].volume).toBe(1000);
    expect(view?.bodies.get(f.b)?.[0].volume).toBe(8000);
    expect(view?.resolved.partKeys.size).toBe(3);
    detach();
  });

  it('配置変更は形の参照を保ち、部品を再計算しない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    const previous = useAppStore.getState().assemblyView?.bodies.get(f.a);
    const previousAppearance = useAppStore.getState().assemblyView?.appearances.get(f.a);
    useAppStore.getState().applyAssembly(moveComponent(f.document, f.document.components[0].id, {
      position: [expressionValueFromNumber(30), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1],
    }));
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().assemblyView?.bodies.get(f.a)).toBe(previous);
    expect(useAppStore.getState().assemblyView?.appearances.get(f.a)).toBe(previousAppearance);
    expect(useAppStore.getState().assemblyView?.resolved.placements.get(f.document.components[0].id)?.position).toEqual([30, 0, 0]);
    detach();
  });

  it('構造化された欠落があれば、その部品だけ再取得する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    fake.keys.delete(fake.recomputeSolids.mock.calls[0][0][0].key);
    useAppStore.getState().applyAssembly({ ...f.document, name: 'changed' });
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(3);
    expect(fake.recomputeSolids.mock.calls[2][1]?.partId).toBe(f.a);
    expect(useAppStore.getState().lastOutcome).toBe('success');
    detach();
  });

  it('取り直しても欠ける形は無限に再試行しない', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    fake.checkShapeAvailability.mockImplementation((partId, keys) => Promise.resolve({ partId, missingKeys: keys }));
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().lastOutcome).toBe('failed');
    expect(useAppStore.getState().assemblyView?.bodies.size).toBe(0);
    detach();
  });

  it('最後のインスタンスが消えた部品だけ releasePart する', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    await settle();
    useAppStore.getState().applyAssembly(removeComponent(f.document, f.document.components[1].id));
    await settle();
    expect(fake.releasePart).toHaveBeenCalledExactlyOnceWith(f.b);
    detach();
    await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledWith(f.a));
  });

  it('遅れて届いた古い世代を適用せず、最新だけを適用する', async () => {
    const library = (await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'a.pcad', '')).library;
    let document = createAssemblyDocument('assembly');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'part-1' }));
    useAppStore.getState().openAssembly(document, library);
    const fake = createFakeRecompute();
    const detach = attachAssembly(fakeBridge().bridge, fake.recompute);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    useAppStore.getState().applyAssembly({ ...document, name: 'latest' });
    expect(fake.calls[0].options.localMesh).toEqual({ maximumFloat32ErrorMm: 0.005, maximumLiveMeshBytes: 512 * 1024 * 1024 });
    expect(fake.calls[0].options.shouldCancel?.()).toBe(true);
    fake.calls[0].options.onResolved?.(resolvePart(fake.calls[0].document));
    fake.calls[0].settle(resultFor(fake.calls[0].document));
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(useAppStore.getState().assemblyView).toBeNull();
    fake.calls[1].options.onResolved?.(resolvePart(fake.calls[1].document));
    fake.calls[1].settle(resultFor(fake.calls[1].document));
    await settle();
    expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    detach();
  });


  it('dragのpreviewは文書・履歴・再計算を変えず、確定後の世代へ表示を引き渡す', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const fake = fakeBridge();
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const before = useAppStore.getState();
      const id = f.document.components[1].id;
      const origin = before.assemblyView?.resolved.placements.get(id)?.position;
      if (origin === undefined) throw new Error('drag origin');
      const plane = componentDragPlane(origin, [0, 0, 1]);
      if (plane === null) throw new Error('drag plane');
      const recomputes = fake.recomputeSolids.mock.calls.length;

      expect(beginComponentDrag(id, plane, origin)).toBe(true);
      expect(moveComponentDrag([origin[0] + 10, origin[1], origin[2]])?.hardSatisfied).toBe(true);
      const preview = useAppStore.getState();
      expect(preview.assembly).toBe(before.assembly);
      expect(preview.assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(preview.requestedGeneration).toBe(before.requestedGeneration);
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(recomputes);
      expect(preview.assemblyDragOverlay).not.toBeNull();

      expect(finishComponentDrag([origin[0] + 10, origin[1], origin[2]])).toBe(true);
      const committed = useAppStore.getState();
      expect(committed.assemblyUndoStack?.past).toHaveLength(1);
      expect(committed.requestedGeneration).toBe(before.requestedGeneration + 1);
      expect(committed.assemblyDragOverlay?.document).toBe(committed.assembly);
      await settle();
      expect(useAppStore.getState().assemblyDragOverlay).toBeNull();
      expect(useAppStore.getState().assemblyView?.sourceDocument).toBe(useAppStore.getState().assembly);
      // 解いた入力は、解と同じ公開で今の文書・一式そのもの(押した時に作り直した写しではない)。
      expect(useAppStore.getState().assemblyView?.source?.document).toBe(useAppStore.getState().assembly);
      expect(useAppStore.getState().assemblyView?.source?.library).toBe(useAppStore.getState().assemblyLibrary);
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(recomputes);
    } finally {
      detach();
    }
  });

  it('新しい合致操作はinteractionが無くてもdragだけを同期取消する', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      const state = useAppStore.getState();
      const id = f.document.components[1].id;
      const origin = state.assemblyView?.resolved.placements.get(id)?.position;
      if (origin === undefined) throw new Error('drag origin');
      const plane = componentDragPlane(origin, [0, 0, 1]);
      if (plane === null) throw new Error('drag plane');
      expect(beginComponentDrag(id, plane, origin)).toBe(true);
      startMate('coincident');
      expect(useAppStore.getState().assemblyDrag).toBeNull();
      expect(useAppStore.getState().assemblyDragOverlay).toBeNull();
      expect(useAppStore.getState().assemblyMateDraft?.kind).toBe('coincident');
    } finally {
      detach();
    }
  });

  it('retains persistent actual Part return failures across detach and recovers only after successful exact claims', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const oldDetach = attachAssembly(fake.bridge);
    await settle();
    expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    let refuse = true;
    fake.releasePart.mockImplementation(() => refuse ? Promise.reject(new Error('actual Part cleanup failed')) : Promise.resolve());
    oldDetach();
    await vi.waitFor(() => expect(fake.releasePart.mock.calls.length).toBeGreaterThanOrEqual(4));
    const newDetach = attachAssembly(fake.bridge);
    try {
      await settle();
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
      const callsWhileFailed = fake.releasePart.mock.calls.length;
      refuse = false;
      useAppStore.getState().applyAssembly({ ...f.document, name: 'after-part-cleanup-recovery' });
      await settle();
      expect(fake.releasePart.mock.calls.length).toBe(callsWhileFailed + 2);
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(4);
      expect(useAppStore.getState().assemblyView?.sourceDocument).toBe(useAppStore.getState().assembly);
      expect(useAppStore.getState().assemblyView?.meshOwnership?.sources.size).toBe(2);
    } finally { refuse = false; oldDetach(); newDetach(); }
  });

  it('keeps a stopped late actual reply owned, blocks new attachment reuse, then recovers after exact return', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const recompute = fake.recomputeSolids.getMockImplementation();
    if (recompute === undefined) throw new Error('Actual fixture recompute');
    let finish: (() => void) | undefined;
    fake.recomputeSolids.mockImplementationOnce((steps, options) => new Promise(resolve => {
      void Promise.resolve(recompute(steps, options)).then(reply => { finish = () => resolve(reply); });
    }));
    const oldDetach = attachAssembly(fake.bridge);
    await vi.waitFor(() => expect(finish).toBeDefined());
    oldDetach();
    const newDetach = attachAssembly(fake.bridge);
    try {
      await settle();
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().assemblyView).toBeNull();
      if (finish === undefined) throw new Error('Actual retained reply');
      finish();
      await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledExactlyOnceWith(f.a));
      expect(useAppStore.getState().assemblyView).toBeNull();
      useAppStore.getState().applyAssembly({ ...f.document, name: 'after-exact-old-return' });
      await settle();
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(3);
      expect(useAppStore.getState().assemblyView?.sourceDocument).toBe(useAppStore.getState().assembly);
      expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
      expect(fake.releasePart).toHaveBeenCalledExactlyOnceWith(f.a);
    } finally { if (finish !== undefined) finish(); oldDetach(); newDetach(); }
  });

  it('Worker の失敗は完了として知らせ、待ち続けない', async () => {
    const f = await fixture();
    useAppStore.getState().openAssembly(f.document, f.library);
    const fake = fakeBridge();
    fake.recomputeSolids.mockRejectedValue(new Error(KERNEL_BROKEN_MESSAGE));
    const detach = attachAssembly(fake.bridge);
    await settle();
    expect(useAppStore.getState().lastOutcome).toBe('workerBroken');
    expect(useAppStore.getState().completedGeneration).toBe(useAppStore.getState().requestedGeneration);
    expect(fake.recomputeSolids.mock.calls.length).toBeGreaterThan(0);
    expect(useAppStore.getState().errorMessage).toContain(KERNEL_BROKEN_MESSAGE);
    expect(useAppStore.getState().isComputing).toBe(false);
    detach();
  });

  it('部品画面では assembly の再計算を呼ばない', () => {
    const fake = fakeBridge();
    const detach = attachAssembly(fake.bridge);
    expect(fake.recomputeSolids).not.toHaveBeenCalled();
    detach();
  });
});

describe('same-source refresh through existing assembly recomputation', () => {
  it('recomputes both shared instances, preserves the unrelated source, and keeps saved missing targets', async () => {
    const f = await fixture();
    const fake = fakeBridge();
    const missing: Mate = { id: 'saved-missing', name: 'Missing', kind: 'coincident', suppressed: false, flipped: false,
      a: { kind: 'subShape', componentId: f.document.components[0].id,
        ref: { bodyFeatureId: 'gone', index: 0, fingerprint: { kind: 'vertex', position: [0, 0, 0] } } },
      b: { kind: 'origin', componentId: f.document.components[1].id, element: 'origin' } };
    const document = { ...f.document, mates: [missing] };
    useAppStore.getState().openAssembly(document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const other = useAppStore.getState().assemblyView?.bodies.get(f.b);
      const part = f.library.parts.get(f.a), attachments = f.library.attachments.get(f.a);
      if (part === undefined || attachments === undefined) throw new Error('Source required');
      const changed = { ...part, name: 'Same source changed' };
      const nextAttachments = { ...attachments, shapes: new Map([['shape-1', Uint8Array.of(12)]]) };
      const bytes = await writeDocumentBundle(createPartDocumentBundle(changed, nextAttachments));
      const refs = JSON.stringify(document.mates);
      let approvals = 0;
      const unsubscribe = useAppStore.subscribe((state) => {
        const request = state.partSourceConfirm;
        if (request === null) return;
        expect(request.sourceName).toBe(part.name);
        expect(request.fileName).toBe('source.pcad');
        expect(request.occurrenceCount).toBe(2);
        expect(request.countComplete).toBe(true);
        approvals += 1;
        state.answerPartSourceConfirm(request.requestId, true);
      });
      try { await startRefreshPartSource(document.components[0].id, {
        choose: () => Promise.resolve({ kind: 'pcad', fileName: 'source.pcad', bytes }),
        read: value => readDocumentBundle(value, 'part'),
        replace: (library, ref, source, value) => replacePartDocument(library, ref, source, { attachments: value }),
      }); }
      finally { unsubscribe(); }
      expect(approvals).toBe(1);
      await settle();
      const view = useAppStore.getState().assemblyView;
      expect(useAppStore.getState().assembly).toBe(document);
      expect(JSON.stringify(useAppStore.getState().assembly?.mates)).toBe(refs);
      expect(view?.bodies.get(f.a)?.[0].volume).toBe(12 ** 3);
      expect(view?.bodies.get(f.b)).toBe(other);
      expect(view?.resolved.partKeys.get(document.components[0].id)).toBe(f.a);
      expect(view?.resolved.partKeys.get(document.components[2].id)).toBe(f.a);
      expect(view?.mateTargetErrors.get(missing.id)?.length).toBeGreaterThan(0);
      expect(view?.mateTargets?.has(missing.id)).toBe(false);
      expect(view?.diagnosis?.skipped.map(({ mateId, reason }) => ({ mateId, reason }))).toEqual([
        { mateId: missing.id, reason: 'dangling' },
      ]);
      expect(view?.diagnosis?.complete).toBe(false);
      expect(view?.diagnosis?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'skippedTarget', severity: 'warning', mateIds: [missing.id] }),
      ]));
      expect(useAppStore.getState().lastOutcome).toBe('failed');
      // This existing provider uses metadata/box fixtures; it proves actual model/store
      // recomputation and refusal to rematch, not native hole-wall semantic continuity.
    } finally { detach(); }
  });
});

describe('bounded Assembly rejection observation (metadata only)', () => {
  it('records the actual unknown receipt reason before cleanup without accepting publication', async () => {
    const f = await fixture(), fake = fakeBridge();
    const events: string[] = [], releasesAtRefusal: number[] = [];
    fake.bridge.captureCurrentMeshLedger = input => Promise.resolve({ status: 'unknown', observationId: input.observationId, reason: 'actual-test-owner-mismatch' });
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge, undefined, event => {
      events.push(event.stage);
      if (event.stage === 'receipt-unknown') releasesAtRefusal.push(fake.releasePart.mock.calls.length);
    });
    try {
      await settle();
      expect(useAppStore.getState().lastOutcome).toBe('failed');
      expect(useAppStore.getState().assemblyView).toBeNull();
      expect(events).toContain('receipt-unknown');
      expect(releasesAtRefusal).toEqual([0]);
      const reading = readAssemblyRecomputeGates();
      expect(reading.events.some(event => event.stage === 'receipt-unknown' && event.reason === 'actual-test-owner-mismatch')).toBe(true);
      expect(fake.releasePart).toHaveBeenCalledWith(f.a);
      expect(fake.releasePart).toHaveBeenCalledWith(f.b);
      expect(reading.acceptanceComplete).toBe(false);
    } finally { detach(); }
  });

  it('keeps inspection rejection distinct and observer failure never changes recomputation or return', async () => {
    const f = await fixture(), fake = fakeBridge();
    fake.bridge.inspectSourceMeshBackings = () => Promise.resolve({ status: 'unknown', reason: 'actual-test-inspection-refused' });
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      expect(useAppStore.getState().lastOutcome).toBe('failed');
      expect(readAssemblyRecomputeGates().events.some(event => event.stage === 'inspection-unknown' && event.reason === 'actual-test-inspection-refused')).toBe(true);
    } finally { detach(); }
    const next = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detachNext = attachAssembly(next.bridge, undefined, () => { throw new Error('observer failed'); });
    try {
      await settle();
      expect(useAppStore.getState().lastOutcome).toBe('success');
      expect(useAppStore.getState().assemblyView?.meshOwnership?.publicationCurrent()).toBe(true);
      expect(readAssemblyRecomputeGates().observerFailures).toBeGreaterThan(0);
      expect(readAssemblyRecomputeGates().status).toBe('unknown');
    } finally { detachNext(); }
    await vi.waitFor(() => expect(next.releasePart).toHaveBeenCalledWith(f.a));
    expect(next.releasePart).toHaveBeenCalledWith(f.b);
  });

  it('bounds metadata and preserves drop evidence instead of claiming full history', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      for (let index = 0; index < 40; index++) {
        useAppStore.getState().applyAssembly({ ...f.document, name: `bounded-${index}` }); await settle();
      }
      const reading = readAssemblyRecomputeGates();
      expect(reading.events).toHaveLength(128);
      expect(reading.dropped).toBeGreaterThan(0);
      expect(reading.status).toBe('unknown');
      expect(new Set(reading.events.map(event => event.seq)).size).toBe(128);
      expect(reading.events.every(event => Object.isFrozen(event))).toBe(true);
      expect(Object.isFrozen(reading.events)).toBe(true);
      expect(useAppStore.getState().lastOutcome).toBe('success');
    } finally { detach(); }
  });
});

describe('same-publication ownership refresh (issued metadata fixture, not native/GPU)', () => {
  it('reacquires an issued current receipt without changing Doc, Undo, generation or borrowed bodies', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const before = useAppStore.getState(), view = before.assemblyView, owner = view?.meshOwnership;
      if (view === null || view === undefined || owner?.refreshOwnership === undefined) throw new Error('Published refresh capability required');
      const borrowed = view.bodies.get(f.a)?.[0];
      if (borrowed === undefined) throw new Error('Strong borrowed Source required');
      await fake.recomputeSolids([], { partId: 'unrelated-fixture-owner', generation: 1 });
      expect(owner.publicationCurrent()).toBe(true);
      expect(owner.receiptCurrent()).toBe(false);
      expect(await owner.refreshOwnership({ ...owner })).toBeNull();
      const fresh = await owner.refreshOwnership(owner);
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(owner);
      expect(fresh?.receiptCurrent()).toBe(true);
      expect(fresh?.backingInspectionCurrent()).toBe(true);
      expect(fresh?.publicationCurrent()).toBe(true);
      const after = useAppStore.getState();
      expect(after.assembly).toBe(before.assembly);
      expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
      expect(after.documentVersion).toBe(before.documentVersion);
      expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(after.requestedGeneration).toBe(before.requestedGeneration);
      expect(after.completedGeneration).toBe(before.completedGeneration);
      expect(after.timelineIndex).toBe(before.timelineIndex);
      expect(after.assemblyView?.bodies).toBe(view.bodies);
      expect(after.assemblyView?.resolved).toBe(view.resolved);
      expect(after.assemblyView?.meshOwnership).toBe(fresh);
      expect(owner.publicationCurrent()).toBe(false);
      expect(borrowed.mesh.positions.byteLength).toBeGreaterThan(0);
      expect(fake.releasePart).not.toHaveBeenCalled();
    } finally { detach(); }
  });

  it('deduplicates the same expected owner and rejects actual cancellation after capture without returning borrowed Source', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    let finish: (() => void) | undefined;
    try {
      await settle();
      const before = useAppStore.getState(), owner = before.assemblyView?.meshOwnership;
      if (owner?.refreshOwnership === undefined) throw new Error('Published refresh capability required');
      const capture = fake.bridge.captureCurrentMeshLedger?.bind(fake.bridge);
      if (capture === undefined) throw new Error('Actual fixture capture required');
      let captures = 0;
      fake.bridge.captureCurrentMeshLedger = input => {
        captures += 1;
        const reply = capture.call(fake.bridge, input);
        return new Promise((resolve, reject) => { finish = () => { void reply.then(resolve, reject); }; });
      };
      const first = owner.refreshOwnership(owner), second = owner.refreshOwnership(owner);
      expect(first).toBe(second);
      expect(captures).toBe(1);
      useAppStore.setState({ recomputeCancelled: true });
      if (finish === undefined) throw new Error('Actual pending capture required');
      finish();
      expect(await first).toBeNull();
      expect(useAppStore.getState().assemblyView?.meshOwnership).toBe(owner);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(useAppStore.getState().requestedGeneration).toBe(before.requestedGeneration);
      expect(fake.releasePart).not.toHaveBeenCalled();
      useAppStore.setState({ recomputeCancelled: false });
      fake.bridge.captureCurrentMeshLedger = capture;
      expect(await owner.refreshOwnership(owner)).not.toBeNull();
    } finally { if (finish !== undefined) finish(); detach(); }
  });

  it('refuses an unknown actual provider reply and detached publication without changing the published owner', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      const before = useAppStore.getState(), owner = before.assemblyView?.meshOwnership;
      if (owner?.refreshOwnership === undefined) throw new Error('Published refresh capability required');
      fake.bridge.captureCurrentMeshLedger = input => Promise.resolve({ status: 'unknown', observationId: input.observationId, reason: 'actual-fixture-refusal' });
      expect(await owner.refreshOwnership(owner)).toBeNull();
      expect(useAppStore.getState().assemblyView).toBe(before.assemblyView);
      expect(fake.releasePart).not.toHaveBeenCalled();
      detach();
      expect(await owner.refreshOwnership(owner)).toBeNull();
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().requestedGeneration).toBe(before.requestedGeneration);
    } finally { detach(); }
  });
});

describe('delayed ownership inspection refuses changed publication and teardown', () => {
  it('rejects a genuine delayed inspection when the actual view identity changes, retaining borrowed Source', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    let finish: (() => void) | undefined;
    try {
      await settle();
      const before = useAppStore.getState(), view = before.assemblyView, owner = view?.meshOwnership;
      if (view === null || view === undefined || owner?.refreshOwnership === undefined) throw new Error('Published refresh capability required');
      const borrowed = view.bodies.get(f.a)?.[0];
      if (borrowed === undefined) throw new Error('Strong borrowed Source required');
      const inspect = fake.bridge.inspectSourceMeshBackings?.bind(fake.bridge);
      if (inspect === undefined) throw new Error('Actual issued inspection required');
      let inspections = 0;
      fake.bridge.inspectSourceMeshBackings = (receipt, inputs) => {
        inspections += 1;
        const reply = inspect.call(fake.bridge, receipt, inputs);
        return new Promise((resolve, reject) => { finish = () => { void reply.then(resolve, reject); }; });
      };
      const pending = owner.refreshOwnership(owner);
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(inspections).toBe(1);
      const changedView = { ...view };
      useAppStore.setState({ assemblyView: changedView });
      if (finish === undefined) throw new Error('Actual pending inspection required');
      finish();
      expect(await pending).toBeNull();
      const after = useAppStore.getState();
      expect(after.assemblyView).toBe(changedView);
      expect(after.assemblyView?.meshOwnership).toBe(owner);
      expect(after.assembly).toBe(before.assembly);
      expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
      expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(after.requestedGeneration).toBe(before.requestedGeneration);
      expect(after.completedGeneration).toBe(before.completedGeneration);
      expect(borrowed.mesh.positions.byteLength).toBeGreaterThan(0);
      expect(fake.releasePart).not.toHaveBeenCalled();
    } finally { if (finish !== undefined) finish(); detach(); }
  });

  it('rejects teardown during genuine delayed inspection and does not return borrowed Source a second time', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    let finish: (() => void) | undefined;
    try {
      await settle();
      const before = useAppStore.getState(), view = before.assemblyView, owner = view?.meshOwnership;
      if (view === null || view === undefined || owner?.refreshOwnership === undefined) throw new Error('Published refresh capability required');
      const borrowed = view.bodies.get(f.a)?.[0];
      if (borrowed === undefined) throw new Error('Strong borrowed Source required');
      const inspect = fake.bridge.inspectSourceMeshBackings?.bind(fake.bridge);
      if (inspect === undefined) throw new Error('Actual issued inspection required');
      fake.bridge.inspectSourceMeshBackings = (receipt, inputs) => {
        const reply = inspect.call(fake.bridge, receipt, inputs);
        return new Promise((resolve, reject) => { finish = () => { void reply.then(resolve, reject); }; });
      };
      const pending = owner.refreshOwnership(owner);
      await vi.waitFor(() => expect(finish).toBeDefined());
      detach();
      await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledWith(f.a));
      await vi.waitFor(() => expect(fake.releasePart).toHaveBeenCalledWith(f.b));
      const actualReturns = fake.releasePart.mock.calls.length;
      if (finish === undefined) throw new Error('Actual pending inspection required');
      finish();
      expect(await pending).toBeNull();
      expect(fake.releasePart).toHaveBeenCalledTimes(actualReturns);
      expect(useAppStore.getState().assemblyView?.meshOwnership).toBe(owner);
      expect(useAppStore.getState().assembly).toBe(before.assembly);
      expect(useAppStore.getState().assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(useAppStore.getState().requestedGeneration).toBe(before.requestedGeneration);
      expect(borrowed.mesh.positions.byteLength).toBeGreaterThan(0);
    } finally { if (finish !== undefined) finish(); detach(); }
  });
});

describe('synchronous ownership-publication subscriber boundary', () => {
  it('rechecks fresh evidence after a subscriber replaces actual Source typed-array identity without releasing borrowed Source', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    const detach = attachAssembly(fake.bridge);
    let unsubscribe: (() => void) | undefined;
    let restore: (() => void) | undefined;
    try {
      await settle();
      const before = useAppStore.getState(), view = before.assemblyView, owner = view?.meshOwnership;
      if (view === null || view === undefined || owner?.refreshOwnership === undefined) throw new Error('Published refresh capability required');
      const borrowed = view.bodies.get(f.a)?.[0];
      if (borrowed === undefined) throw new Error('Strong borrowed Source required');
      const originalPositions = borrowed.mesh.positions;
      const replacement = new Float32Array(originalPositions);
      restore = () => { expect(Reflect.set(borrowed.mesh, 'positions', originalPositions)).toBe(true); };
      let mutated = false;
      unsubscribe = useAppStore.subscribe(next => {
        if (mutated || next.assemblyView === null || next.assemblyView.meshOwnership === owner) return;
        mutated = true;
        expect(Reflect.set(borrowed.mesh, 'positions', replacement)).toBe(true);
        expect(borrowed.mesh.positions).toBe(replacement);
      });
      expect(await owner.refreshOwnership(owner)).toBeNull();
      expect(mutated).toBe(true);
      const after = useAppStore.getState();
      expect(after.assemblyView?.bodies).toBe(view.bodies);
      expect(after.assemblyView?.meshOwnership?.sources).toBe(owner.sources);
      expect(after.assemblyView?.meshOwnership?.publicationCurrent()).toBe(true);
      expect(after.assembly).toBe(before.assembly);
      expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
      expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(after.requestedGeneration).toBe(before.requestedGeneration);
      expect(after.completedGeneration).toBe(before.completedGeneration);
      expect(originalPositions.byteLength).toBeGreaterThan(0);
      expect(replacement.byteLength).toBe(originalPositions.byteLength);
      expect(fake.releasePart).not.toHaveBeenCalled();
    } finally { unsubscribe?.(); restore?.(); detach(); }
  });
});

describe('first actual publication refresh before drain bookkeeping completes', () => {
  it('refreshes the genuine published owner from a subscriber microtask without changing request or borrowed resources', async () => {
    const f = await fixture(), fake = fakeBridge();
    useAppStore.getState().openAssembly(f.document, f.library);
    let attempt: Promise<void> | null = null;
    const unsubscribe = useAppStore.subscribe(next => {
      const view = next.assemblyView, owner = view?.meshOwnership;
      if (attempt !== null || view === null || view === undefined || owner === undefined) return;
      const before = next;
      attempt = Promise.resolve().then(async () => {
        if (owner.refreshOwnership === undefined) throw new Error('Genuine published refresh capability required');
        expect(useAppStore.getState().assemblyView?.meshOwnership).toBe(owner);
        expect(useAppStore.getState().isComputing).toBe(false);
        const fresh = await owner.refreshOwnership(owner);
        expect(fresh).not.toBeNull();
        expect(fresh).not.toBe(owner);
        expect(fresh?.publicationCurrent()).toBe(true);
        expect(fresh?.receiptCurrent()).toBe(true);
        expect(fresh?.backingInspectionCurrent()).toBe(true);
        const after = useAppStore.getState();
        expect(after.assembly).toBe(before.assembly);
        expect(after.assemblyLibrary).toBe(before.assemblyLibrary);
        expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
        expect(after.documentVersion).toBe(before.documentVersion);
        expect(after.requestedGeneration).toBe(before.requestedGeneration);
        expect(after.completedGeneration).toBe(before.completedGeneration);
        expect(after.assemblyView?.bodies).toBe(view.bodies);
        expect(after.assemblyView?.resolved).toBe(view.resolved);
        expect(after.assemblyView?.meshOwnership).toBe(fresh);
        expect(view.bodies.get(f.a)?.[0].mesh.positions.byteLength).toBeGreaterThan(0);
        expect(fake.releasePart).not.toHaveBeenCalled();
      });
      // Observe rejection immediately; awaiting the original Promise below still fails the test.
      void attempt.catch(() => undefined);
    });
    const detach = attachAssembly(fake.bridge);
    try {
      await settle();
      if (attempt === null) throw new Error('Actual first publication subscriber must run');
      await Promise.resolve(attempt);
      expect(fake.recomputeSolids).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); detach(); }
  });
});

/*
 * Heterogeneous 1000-definition assembly through the actual publisher (UNEXECUTED until Root runs it).
 * 1000 distinct embedded part definitions plus 200 repeated occurrences. Expected identities come from the fixture
 * inputs (embedded refs and component order), not from the published view.
 */
describe('1000 distinct part definitions: superseded and cancelled requests never publish a partial scene', () => {
  const DEFINITIONS = 1000, REPEATS = 200, EDITED = 10, INTERRUPTED_AT = 400;
  type PendingCall = ReturnType<typeof createFakeRecompute>['calls'][number];

  async function heterogeneous() {
    let library = EMPTY_PART_LIBRARY;
    const refs: string[] = [];
    for (let index = 0; index < DEFINITIONS; index += 1) {
      const label = String(index);
      const part: PartDocument = { ...createEmptyPartDocument(), id: `definition-${label}`, name: `definition ${label}` };
      const embedded = await embedPart(library, part, `p${label}.pcad`, `p${label}.pcad`);
      library = embedded.library; refs.push(embedded.partRef);
    }
    // Different definitions are never merged into one embedded ref.
    expect(new Set(refs).size).toBe(DEFINITIONS);
    const occurrenceRefs = [...refs, ...refs.slice(0, REPEATS)];
    let document = createAssemblyDocument('heterogeneous');
    for (const partRef of occurrenceRefs) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }));
    const expectedKeys = new Map(document.components.map((component, index) => [component.id, occurrenceRefs[index]]));
    expect(expectedKeys.size).toBe(DEFINITIONS + REPEATS);
    return { document, library, refs, expectedKeys };
  }

  /** Waits for the index-th part recompute without polling intervals (each step only needs queued tasks to run). */
  async function nextCall(fake: ReturnType<typeof createFakeRecompute>, index: number): Promise<PendingCall> {
    for (let attempt = 0; attempt < 1000 && fake.calls.length <= index; attempt += 1) {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    }
    const call = fake.calls[index];
    if (call === undefined) throw new Error(`Part recompute ${String(index)} did not start`);
    return call;
  }

  /** Replies like the fake test helpers above; records the handed ResolvedPart only for replies that may publish. */
  function answer(call: PendingCall, handed: Map<string, ReturnType<typeof resolvePart>> | null): void {
    const resolved = resolvePart(call.document);
    call.options.onResolved?.(resolved);
    if (handed !== null) handed.set(call.options.partId ?? '', resolved);
    call.settle(resultFor(call.document));
  }

  function expectComplete(f: Awaited<ReturnType<typeof heterogeneous>>, handed: ReadonlyMap<string, ReturnType<typeof resolvePart>>) {
    const state = useAppStore.getState();
    expect(state.lastOutcome).toBe('success');
    expect(state.recomputeCancelled).toBe(false);
    const view = state.assemblyView;
    if (view === null) throw new Error('The latest request must publish');
    expect([...view.bodies.keys()].sort()).toEqual([...f.refs].sort());
    expect(new Map(view.resolved.partKeys)).toEqual(f.expectedKeys);
    expect([...view.resolved.placements.keys()].sort()).toEqual([...f.expectedKeys.keys()].sort());
    expect(view.resolved.parts.size).toBe(DEFINITIONS);
    for (const ref of f.refs) expect(view.resolved.parts.get(ref)).toBe(handed.get(ref));
    return view;
  }

  it('reuses only finished unchanged definitions after an overlapping edit and publishes every occurrence once', async () => {
    const f = await heterogeneous();
    useAppStore.getState().openAssembly(f.document, f.library);
    const fake = createFakeRecompute();
    const handed = new Map<string, ReturnType<typeof resolvePart>>();
    const detach = attachAssembly(fakeBridge().bridge, fake.recompute);
    try {
      for (let index = 0; index < INTERRUPTED_AT; index += 1) {
        const call = await nextCall(fake, index);
        expect(call.options.partId).toBe(f.refs[index]);
        answer(call, handed);
      }
      const late = await nextCall(fake, INTERRUPTED_AT);
      expect(late.options.partId).toBe(f.refs[INTERRUPTED_AT]);
      const firstGeneration = useAppStore.getState().requestedGeneration;
      const original = f.library.parts.get(f.refs[EDITED]);
      if (original === undefined) throw new Error('Edited definition missing');
      const edited: PartDocument = { ...original, name: 'edited definition' };
      const current = useAppStore.getState();
      useAppStore.setState({ assemblyLibrary: { ...current.assemblyLibrary,
        parts: new Map(current.assemblyLibrary.parts).set(f.refs[EDITED], edited) } });
      expect(useAppStore.getState().requestedGeneration).toBe(firstGeneration + 1);
      expect(late.options.shouldCancel?.()).toBe(true);
      // The superseded request's late reply must not publish the 400 finished definitions as a scene.
      answer(late, null);
      const first = await nextCall(fake, INTERRUPTED_AT + 1);
      expect(useAppStore.getState().assemblyView).toBeNull();
      expect(useAppStore.getState().completedGeneration).toBeLessThan(firstGeneration);
      // The newer request recomputes the edited definition and the unfinished ones, in component order only.
      expect(first.options.partId).toBe(f.refs[EDITED]);
      expect(first.document).toBe(edited);
      answer(first, handed);
      for (let offset = 0; offset < DEFINITIONS - INTERRUPTED_AT; offset += 1) {
        const call = await nextCall(fake, INTERRUPTED_AT + 2 + offset);
        expect(call.options.partId).toBe(f.refs[INTERRUPTED_AT + offset]);
        expect(call.document).toBe(f.library.parts.get(f.refs[INTERRUPTED_AT + offset]));
        answer(call, handed);
      }
      await settle();
      expect(fake.calls).toHaveLength(DEFINITIONS + 2);
      expect(useAppStore.getState().completedGeneration).toBe(firstGeneration + 1);
      const view = expectComplete(f, handed);
      expect(view.sourceDocument).toBe(f.document);
      expect(view.meshOwnership?.sources.get(f.refs[EDITED])?.document).toBe(edited);
      expect(view.meshOwnership?.sources.get(f.refs[0])?.document).toBe(f.library.parts.get(f.refs[0]));
    } finally { detach(); }
  }, 180_000);

  it('a cancel mid-loop publishes nothing, and the next edit recomputes only the definitions the cancel left unfinished', async () => {
    const f = await heterogeneous();
    useAppStore.getState().openAssembly(f.document, f.library);
    const fake = createFakeRecompute();
    const handed = new Map<string, ReturnType<typeof resolvePart>>();
    const detach = attachAssembly(fakeBridge().bridge, fake.recompute);
    try {
      for (let index = 0; index < INTERRUPTED_AT; index += 1) answer(await nextCall(fake, index), handed);
      const late = await nextCall(fake, INTERRUPTED_AT);
      useAppStore.getState().cancelRecompute();
      expect(late.options.shouldCancel?.()).toBe(true);
      answer(late, null);
      await vi.waitFor(() => expect(useAppStore.getState().isComputing).toBe(false));
      expect(useAppStore.getState().recomputeCancelled).toBe(true);
      expect(useAppStore.getState().assemblyView).toBeNull();
      expect(fake.calls).toHaveLength(INTERRUPTED_AT + 1);

      const renamed: AssemblyDocument = { ...f.document, name: 'after cancel' };
      useAppStore.getState().applyAssembly(renamed);
      for (let offset = 0; offset < DEFINITIONS - INTERRUPTED_AT; offset += 1) {
        const call = await nextCall(fake, INTERRUPTED_AT + 1 + offset);
        expect(call.options.partId).toBe(f.refs[INTERRUPTED_AT + offset]);
        answer(call, handed);
      }
      await settle();
      expect(fake.calls).toHaveLength(DEFINITIONS + 1);
      expect(expectComplete(f, handed).sourceDocument).toBe(useAppStore.getState().assembly);
      expect(useAppStore.getState().assembly?.name).toBe('after cancel');
    } finally { detach(); }
  }, 180_000);
});

/*
 * EX12 flexible child (UNEXECUTED until Root runs it): a child assembly's own mates are solved inside each solved
 * parent frame. Expected world positions are composed by hand from the fixture placements.
 */
describe('child assembly mates are solved in each parent occurrence frame', () => {
  const ev = expressionValueFromNumber;
  /** Rz(+90deg) as [x, y, z, w]: (x, y, z) -> (-y, x, z). */
  const QUARTER_Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;

  /** Child: fixed part a at the child origin; part b authored at (5, 0, 0), pulled onto a's origin by a coincident mate. */
  async function nested(conflict: boolean) {
    const f = await fixture();
    let child = createAssemblyDocument('child');
    for (const partRef of [f.a, f.b]) child = addComponent(child, createComponentFor(child, { kind: 'part', partRef }));
    child = moveComponent(child, child.components[1].id, { position: [ev(5), ev(0), ev(0)], rotation: [0, 0, 0, 1] });
    const coincident = originMate(child, 'coincident');
    child = { ...child,
      components: child.components.map((component, index) => (index === 0 ? { ...component, fixed: true } : component)),
      mates: conflict ? [coincident, { ...originMate(child, 'distance', 10), id: 'mate-2' }] : [coincident] };
    const library = { ...f.library, assemblies: new Map([['child-ref', child]]) };
    let document = createAssemblyDocument('parent');
    for (let index = 0; index < 2; index += 1) {
      document = addComponent(document, createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child-ref' }));
    }
    document = moveComponent(document, document.components[0].id, { position: [ev(100), ev(0), ev(0)], rotation: [...QUARTER_Z] });
    document = moveComponent(document, document.components[1].id, { position: [ev(0), ev(50), ev(0)], rotation: [0, 0, 0, 1] });
    return { f, child, library, document };
  }

  function expectNear(actual: readonly number[] | undefined, expected: readonly number[]): void {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 9));
  }

  it('places both occurrences of one child definition from their own parent frame and keeps the authored documents', async () => {
    const { f, child, library, document } = await nested(false);
    useAppStore.getState().openAssembly(document, library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      const state = useAppStore.getState();
      expect(state.lastOutcome).toBe('success');
      const view = state.assemblyView;
      if (view === null) throw new Error('The view must publish');
      const [childA, childB] = child.components.map((component) => component.id);
      // Parent frames from the fixture: occurrence 1 at (100, 0, 0) turned Rz(90), occurrence 2 at (0, 50, 0).
      const frames = [{ id: document.components[0].id, position: [100, 0, 0], rotation: [...QUARTER_Z] },
        { id: document.components[1].id, position: [0, 50, 0], rotation: [0, 0, 0, 1] }];
      for (const frame of frames) {
        const occurrence = view.resolved.subAssemblies?.get(frame.id);
        if (occurrence === undefined) throw new Error(`Occurrence ${frame.id} missing`);
        expect(occurrence.placement).toEqual(view.resolved.placements.get(frame.id));
        expectNear(occurrence.placement.position, frame.position);
        // a sits at the child origin; the coincident mate puts b there too: both land on the parent origin.
        // Unsolved, b would be parent ∘ (5, 0, 0): (100, 5, 0) and (5, 50, 0).
        for (const id of [childA, childB]) {
          expectNear(occurrence.resolved.placements.get(id)?.position, frame.position);
          expectNear(occurrence.resolved.placements.get(id)?.rotation, frame.rotation);
        }
        // The repeated child definition shares the same part keys in both occurrences.
        expect(occurrence.resolved.partKeys.get(childA)).toBe(f.a);
        expect(occurrence.resolved.partKeys.get(childB)).toBe(f.b);
      }
      // Solving never writes back into the saved documents (no Undo entry is needed or made).
      expect(state.assembly).toBe(document);
      expect(state.assemblyLibrary.assemblies?.get('child-ref')).toBe(child);
      expect(child.components[1].placement.position[0].value).toBe(5);
    } finally { detach(); }
  });

  it('reports a contradictory child with the occurrence name, keeps the documents and re-frames the child', async () => {
    const { child, library, document } = await nested(true);
    useAppStore.getState().openAssembly(document, library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      const state = useAppStore.getState();
      expect(state.lastOutcome).toBe('failed');
      expect(state.errorMessage).toContain(`${document.components[0].name}: `);
      expect(state.errorMessage).toContain(`${document.components[1].name}: `);
      expect(state.assembly).toBe(document);
      expect(state.assemblyLibrary.assemblies?.get('child-ref')).toBe(child);
      const occurrence = state.assemblyView?.resolved.subAssemblies?.get(document.components[1].id);
      if (occurrence === undefined) throw new Error('Occurrence missing');
      expect(occurrence.placement).toEqual(state.assemblyView?.resolved.placements.get(document.components[1].id));
      // Not solved: b stays at its authored child position, composed with the parent (0, 50, 0): (5, 50, 0).
      expectNear(occurrence.resolved.placements.get(child.components[1].id)?.position, [5, 50, 0]);
    } finally { detach(); }
  });
});

/*
 * EX12 moved parent (UNEXECUTED until Root runs it; needs the task85 attachAssembly product edit cd04140b): a top-level
 * mate moves a sub-assembly occurrence away from its authored placement; the child's solved placements and
 * nested.placement follow the moved parent, and the sibling occurrence keeps its authored frame.
 */
describe('a top-level mate that moves a sub-assembly occurrence carries its solved children along', () => {
  const ev = expressionValueFromNumber;
  /** Rz(+90deg) as [x, y, z, w]: (x, y, z) -> (-y, x, z). */
  const QUARTER_Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;

  function expectNear(actual: readonly number[] | undefined, expected: readonly number[]): void {
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, index) => expect(actual?.[index]).toBeCloseTo(value, 9));
  }

  it('composes the child with the solved parent pose and leaves the sibling occurrence where it was authored', async () => {
    const f = await fixture();
    // Child: fixed a at the origin, b authored at (5, 0, 0) pulled onto a's origin, free c authored at (0, 7, 0).
    let child = createAssemblyDocument('child');
    for (const partRef of [f.a, f.b, f.a]) child = addComponent(child, createComponentFor(child, { kind: 'part', partRef }));
    child = moveComponent(child, child.components[1].id, { position: [ev(5), ev(0), ev(0)], rotation: [0, 0, 0, 1] });
    child = moveComponent(child, child.components[2].id, { position: [ev(0), ev(7), ev(0)], rotation: [0, 0, 0, 1] });
    child = { ...child, components: child.components.map((component, index) => (index === 0 ? { ...component, fixed: true } : component)),
      mates: [originMate(child, 'coincident')] };
    const library = { ...f.library, assemblies: new Map([['child-ref', child]]) };
    // Parent: fixed ground at (30, 0, 0); S1 authored at (100, 0, 0) turned Rz(90); S2 authored at (0, 50, 0).
    let document = createAssemblyDocument('parent');
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: f.b }));
    for (let index = 0; index < 2; index += 1) {
      document = addComponent(document, createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child-ref' }));
    }
    document = moveComponent(document, document.components[0].id, { position: [ev(30), ev(0), ev(0)], rotation: [0, 0, 0, 1] });
    document = moveComponent(document, document.components[1].id, { position: [ev(100), ev(0), ev(0)], rotation: [...QUARTER_Z] });
    document = moveComponent(document, document.components[2].id, { position: [ev(0), ev(50), ev(0)], rotation: [0, 0, 0, 1] });
    // The top-level coincident origin mate pulls S1's origin onto the fixed ground origin.
    document = { ...document, components: document.components.map((component, index) => (index === 0 ? { ...component, fixed: true } : component)),
      mates: [originMate(document, 'coincident')] };
    useAppStore.getState().openAssembly(document, library);
    const detach = attachAssembly(fakeBridge().bridge);
    try {
      await settle();
      const state = useAppStore.getState();
      expect(state.lastOutcome).toBe('success');
      const view = state.assemblyView;
      if (view === null) throw new Error('The view must publish');
      const [ground, s1, s2] = document.components.map((component) => component.id);
      const [childA, childB, childC] = child.components.map((component) => component.id);
      expectNear(view.resolved.placements.get(ground)?.position, [30, 0, 0]);
      // S1 moved by the mate; a point coincidence leaves its orientation.
      expectNear(view.resolved.placements.get(s1)?.position, [30, 0, 0]);
      expectNear(view.resolved.placements.get(s1)?.rotation, QUARTER_Z);
      const moved = view.resolved.subAssemblies?.get(s1);
      if (moved === undefined) throw new Error('S1 occurrence missing');
      expect(moved.placement).toEqual(view.resolved.placements.get(s1));
      // a and b at the child origin -> the moved parent origin; c local (0, 7, 0) -> Rz(90) (-7, 0, 0) + (30, 0, 0).
      // Composed with the authored parent they would be (100, 0, 0) and (93, 0, 0).
      expectNear(moved.resolved.placements.get(childA)?.position, [30, 0, 0]);
      expectNear(moved.resolved.placements.get(childB)?.position, [30, 0, 0]);
      expectNear(moved.resolved.placements.get(childC)?.position, [23, 0, 0]);
      expectNear(moved.resolved.placements.get(childC)?.rotation, QUARTER_Z);
      // The sibling occurrence of the same child keeps its authored frame (0, 50, 0).
      const sibling = view.resolved.subAssemblies?.get(s2);
      if (sibling === undefined) throw new Error('S2 occurrence missing');
      expectNear(sibling.placement.position, [0, 50, 0]);
      expectNear(sibling.resolved.placements.get(childB)?.position, [0, 50, 0]);
      expectNear(sibling.resolved.placements.get(childC)?.position, [0, 57, 0]);
      // Solving writes nothing back: S1 is still authored at (100, 0, 0).
      expect(state.assembly).toBe(document);
      expect(state.assembly?.components[1].placement.position[0].value).toBe(100);
    } finally { detach(); }
  });
});

describe('EX-12 W05 initial mate checkpoints own their document and publication', () => {
  async function input(nested: boolean) {
    const f = await fixture();
    const moved = moveComponent(f.document, f.document.components[1].id, {
      position: [expressionValueFromNumber(12), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1],
    });
    const child = { ...moved, mates: [originMate(moved, 'coincident')] };
    if (!nested) return { document: child, library: f.library };
    const document = addComponent(createAssemblyDocument('parent'),
      createComponentFor(createAssemblyDocument('parent'), { kind: 'subAssembly', assemblyRef: 'child' }));
    return { document, library: { ...f.library, assemblies: new Map([['child', child]]) } };
  }

  function serialized(value: unknown): string {
    return JSON.stringify(value, (_key, entry: unknown) => entry instanceof Map ? [...entry.entries()] : entry);
  }

  async function microtasks(): Promise<void> {
    // The recomputer/receipt fixture resolves promises only; no timers are used to drive the solver in these tests.
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
  }

  async function flush(queue: (() => void)[]): Promise<void> {
    for (let turn = 0; turn < 100; turn += 1) {
      await microtasks();
      let slices = 0;
      while (queue.length > 0) {
        queue.shift()?.();
        slices += 1;
        if (slices > 10000) throw new Error('Unexpected unbounded constraint work');
      }
      await microtasks();
      if (queue.length === 0 && !useAppStore.getState().isComputing) return;
    }
    throw new Error('Assembly request did not reach its terminal state');
  }

  it.each([false, true])('at every root/child checkpoint (nested=%s), cancel keeps the old view and publishes zero', async nested => {
    const f = await input(nested), before = serialized(f), fake = fakeBridge();
    const queue: (() => void)[] = [], progress: number[] = [], published: (AssemblyDocument | undefined)[] = [];
    let stop: number | null = null;
    const execution: AssemblyConstraintExecution = { budget: { units: 1 }, pointsPerSlice: 1,
      schedule: slice => { queue.push(slice); }, onProgress: done => {
        progress.push(done);
        if (progress.length === stop) useAppStore.getState().cancelRecompute();
      } };
    useAppStore.getState().openAssembly(f.document, f.library);
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.assemblyView !== null && next.assemblyView !== previous.assemblyView) published.push(next.assemblyView.sourceDocument);
    });
    const detach = attachAssembly(fake.bridge, undefined, undefined, execution);
    try {
      await flush(queue);
      expect(useAppStore.getState().lastOutcome).toBe('success');
      expect(published).toEqual([f.document]);
      const trace = [...progress], oldView = useAppStore.getState().assemblyView;
      expect(trace.length).toBeGreaterThan(2);
      trace.forEach((done, i) => expect(done).toBeGreaterThanOrEqual(trace[i - 1] ?? 0));
      for (let checkpoint = 0; checkpoint <= trace.length; checkpoint += 1) {
        stop = checkpoint;
        progress.length = 0;
        published.length = 0;
        const document = { ...f.document, name: `cancel at ${checkpoint}` };
        useAppStore.getState().applyAssembly(document);
        const requestInput = serialized(document), history = useAppStore.getState().assemblyUndoStack;
        if (checkpoint === 0) {
          await microtasks();
          expect(queue.length).toBeGreaterThan(0);
          useAppStore.getState().cancelRecompute();
        }
        await flush(queue);
        const state = useAppStore.getState();
        expect(published).toEqual([]);
        expect(state.assemblyView).toBe(oldView);
        expect(state.assembly).toBe(document);
        expect(state.assemblyUndoStack).toBe(history);
        expect(state.lastOutcome).toBe('cancelled');
        expect(state.completedGeneration).toBe(state.requestedGeneration);
        expect(state.recomputeCancelled).toBe(true);
        expect(progress).toEqual(trace.slice(0, checkpoint));
        expect(serialized(document)).toBe(requestInput);
        expect(serialized(f)).toBe(before);
      }
      // A successful later request uses the same real inputs and publishes exactly once.
      stop = null;
      progress.length = 0;
      const retry = { ...f.document, name: 'successful retry' };
      useAppStore.getState().applyAssembly(retry);
      await flush(queue);
      expect(published).toEqual([retry]);
      expect(useAppStore.getState().lastOutcome).toBe('success');
      expect(progress).toEqual(trace);
    } finally { unsubscribe(); detach(); await microtasks(); }
  });

  it('at every checkpoint, switching documents discards the old solve/diagnosis and publishes the new owner once', async () => {
    const f = await input(false), before = serialized(f), fake = fakeBridge();
    const queue: (() => void)[] = [], progress: number[] = [], published: (AssemblyDocument | undefined)[] = [];
    let stop: number | null = null;
    let replacement = { ...f.document, name: 'replacement', mates: [] };
    const execution: AssemblyConstraintExecution = { budget: { units: 1 }, pointsPerSlice: 1,
      schedule: slice => { queue.push(slice); }, onProgress: done => {
        progress.push(done);
        if (progress.length === stop) useAppStore.getState().openAssembly(replacement, f.library);
      } };
    useAppStore.getState().openAssembly(f.document, f.library);
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.assemblyView !== null && next.assemblyView !== previous.assemblyView) published.push(next.assemblyView.sourceDocument);
    });
    const detach = attachAssembly(fake.bridge, undefined, undefined, execution);
    try {
      await flush(queue);
      const trace = [...progress];
      expect(published).toEqual([f.document]);
      for (let checkpoint = 0; checkpoint <= trace.length; checkpoint += 1) {
        stop = checkpoint;
        progress.length = 0;
        published.length = 0;
        replacement = { ...f.document, name: `replacement ${checkpoint}`, mates: [] };
        const old = { ...f.document, name: `obsolete ${checkpoint}` };
        useAppStore.getState().openAssembly(old, f.library);
        if (checkpoint === 0) {
          await microtasks();
          expect(queue.length).toBeGreaterThan(0);
          useAppStore.getState().openAssembly(replacement, f.library);
        }
        await flush(queue);
        const state = useAppStore.getState();
        expect(published).toEqual([replacement]);
        expect(state.assembly).toBe(replacement);
        expect(state.assemblyView?.sourceDocument).toBe(replacement);
        expect(state.lastOutcome).toBe('success');
        expect(state.completedGeneration).toBe(state.requestedGeneration);
        expect(state.recomputeCancelled).toBe(false);
        expect(progress).toEqual(trace.slice(0, checkpoint));
        expect(serialized(f)).toBe(before);
      }
    } finally { unsubscribe(); detach(); await microtasks(); }
  });

  it.each(['solve', 'diagnose'] as const)('detaching during %s rejects late queued slices without publishing into a later attachment', async phase => {
    const f = await input(false), fake = fakeBridge(), queue: (() => void)[] = [];
    const phases: string[] = [], published: (AssemblyDocument | undefined)[] = [];
    useAppStore.getState().openAssembly(f.document, f.library);
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.assemblyView !== null && next.assemblyView !== previous.assemblyView) published.push(next.assemblyView.sourceDocument);
    });
    const detach = attachAssembly(fake.bridge, undefined, event => {
      if (event.stage === 'constraints-start' && event.reason !== null) phases.push(event.reason);
    }, { budget: { units: 1 }, pointsPerSlice: 1, schedule: slice => { queue.push(slice); } });
    let detachNext: (() => void) | undefined;
    try {
      for (let turn = 0; turn < 10000 && !phases.includes(phase); turn += 1) {
        await microtasks();
        if (!phases.includes(phase)) queue.shift()?.();
      }
      expect(phases).toContain(phase);
      expect(queue.length).toBeGreaterThan(0);
      queue.shift()?.(); // Stop after actual work, with another slice still enqueued.
      detach();
      const replacement = { ...f.document, name: 'new attachment', mates: [] };
      useAppStore.getState().openAssembly(replacement, f.library);
      detachNext = attachAssembly(fakeBridge().bridge);
      while (queue.length > 0) queue.shift()?.();
      await settle();
      expect(published).toEqual([replacement]);
      expect(useAppStore.getState().assemblyView?.sourceDocument).toBe(replacement);
    } finally { unsubscribe(); detach(); detachNext?.(); await microtasks(); }
  });

  it('a synchronous owner change at the final admission observer cannot publish the completed old result', async () => {
    const f = await input(false), replacement = { ...f.document, name: 'new at admission', mates: [] };
    const published: (AssemblyDocument | undefined)[] = [];
    useAppStore.getState().openAssembly(f.document, f.library);
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.assemblyView !== null && next.assemblyView !== previous.assemblyView) published.push(next.assemblyView.sourceDocument);
    });
    let replaced = false;
    const detach = attachAssembly(fakeBridge().bridge, undefined, event => {
      if (!replaced && event.stage === 'publication-admitted') {
        replaced = true;
        useAppStore.getState().openAssembly(replacement, f.library);
      }
    });
    try {
      await settle();
      expect(replaced).toBe(true);
      expect(published).toEqual([replacement]);
      expect(useAppStore.getState().assemblyView?.sourceDocument).toBe(replacement);
    } finally { unsubscribe(); detach(); }
  });
});
