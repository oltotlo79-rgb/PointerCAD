import { beforeEach, describe, expect, it } from 'vitest';
import { createAssemblyDocument, createEmptyPartDocument, DEFAULT_COMPONENT_PLACEMENT, EMPTY_PART_LIBRARY,
  IDENTITY_PLACEMENT, type SolidBody } from '@pointercad/model';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureMeshBodyLayout } from '../store/recomputeSlice.js';
import { buildAssemblyGeometry } from './createAssemblyLayer.js';
import { assemblyUiBackings, AssemblyUiBackingLedger, assemblyMeshBudget, captureAssemblyMeshAdmission, currentAssemblyMeshAdmission, currentAssemblyMeshPublication,
  type AssemblyMeshOwnership, type AssemblySourceMeshOwner } from './assemblyMeshAdmission.js';

beforeEach(resetTestStore);

describe('shared actual UI backing identity', () => {
  it('counts two Scene allocations and one backing shared by both exactly once', () => {
    const ledger = new AssemblyUiBackingLedger(), first = {}, second = {};
    const shared = new Float32Array(12), separate = new Float32Array(8);
    ledger.reserve(first, shared.byteLength, 100, 1000); ledger.adopt([shared.buffer]); ledger.retire(first);
    ledger.reserve(second, separate.byteLength, 100, 1000); ledger.adopt([shared.buffer, separate.buffer]); ledger.retire(second);
    expect(ledger.bytes()).toBe(shared.byteLength + separate.byteLength);
    expect(ledger.buffers()).toEqual([shared.buffer, separate.buffer]);
    expect(() => ledger.reserve({}, 1, 100, 100 + ledger.bytes())).toThrow(RangeError);
  });

  it('keeps a real failed disposer backing and retries only that owner', () => {
    const ledger = new AssemblyUiBackingLedger(), owner = {}, buffer = new ArrayBuffer(64);
    ledger.reserve(owner, buffer.byteLength, 100, 164); ledger.adopt([buffer]); ledger.retire(owner);
    let failures = true, attempts = 0;
    const pending = [() => { attempts += 1; if (failures) throw new Error('Actual asset return failed'); return buffer.byteLength; }];
    expect(() => pending[0]()).toThrow();
    expect(ledger.bytes()).toBe(64); expect(ledger.pending()).toBe(0);
    expect(() => ledger.reserve({}, 1, 100, 164)).toThrow(RangeError);
    failures = false; expect(pending[0]()).toBe(64); ledger.retire(owner);
    expect(attempts).toBe(2); expect(ledger.pending()).toBe(0); expect(ledger.bytes()).toBe(64);
  });

  it('deduplicates an actual UI backing that reentered Source while preserving fresh baseline and limit', () => {
    const ledger = new AssemblyUiBackingLedger(), returnedToSource = new ArrayBuffer(32), distinctUi = new ArrayBuffer(24);
    ledger.adopt([returnedToSource, distinctUi]);
    const intersection = new Set<ArrayBufferLike>([returnedToSource]);
    expect(() => ledger.reserve({}, 8, 100, 132, intersection)).not.toThrow();
    expect(() => ledger.reserve({}, 1, 100, 132, intersection)).toThrow(RangeError);
    expect(ledger.bytes()).toBe(56); // UI ledger retains both exact backings; only admission avoids the Source duplicate.
    const emptyIntersection = new Set<ArrayBufferLike>();
    expect(() => ledger.reserve({}, 0, 100, 132, emptyIntersection)).toThrow(RangeError);
  });

  it('does not remove a live borrowed buffer when its publishing owner closes', () => {
    const ledger = new AssemblyUiBackingLedger(), owner = {}, borrowed = new ArrayBuffer(80);
    ledger.reserve(owner, borrowed.byteLength, 0, 80); ledger.adopt([borrowed]); ledger.retire(owner);
    expect(ledger.pending()).toBe(0); expect(ledger.buffers()).toContain(borrowed); expect(ledger.bytes()).toBe(80);
    expect(() => ledger.reserve({}, 1, 0, 80)).toThrow(RangeError);
  });
});

/** Metadata-only boundary fixture. It is not a bridge-issued receipt or physical accounting proof. */
function fixture() {
  const part = createEmptyPartDocument();
  const body: SolidBody = { featureId: 'body', isValid: true, volume: 0, faces: [], edges: [], vertices: [], threadMarks: [],
    mesh: { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]), edgePositions: new Float32Array(0), triangleCount: 1 } };
  const bodies = new Map([['part-1', [body]]]);
  const component = { id: 'component-1', name: 'part', source: { kind: 'part' as const, partRef: 'part-1' },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false };
  const document = { ...createAssemblyDocument('admission'), components: [component] };
  const placements = new Map([['component-1', IDENTITY_PLACEMENT]]), partKeys = new Map([['component-1', 'part-1']]);
  const result = { ...resultFor(part), bodies: bodies.get('part-1') ?? [], generation: 7 };
  const displayOwner = { dispatchId: 'display-7', partId: 'part-1', generation: 7,
    kind: 'display' as const, steps: [{ id: 'body', key: 'key-7' }] };
  const current = { source: true, ledger: true, publication: true, membership: true };
  const source: AssemblySourceMeshOwner = { document: part, attachments: undefined, result, bodies: result.bodies,
    layouts: result.bodies.map(captureMeshBodyLayout), displayOwner, hiddenOwners: [], current: () => current.source };
  const receipt: AssemblyMeshOwnership['receipt'] = { status: 'known', observationId: 'metadata-test', hostEpoch: 2,
    workerEpochs: [{ providerId: 1, connectionEpoch: 1, cache: 2, owners: 2 }], owners: [displayOwner],
    limitBytes: 1000000, workerRetainedBackingBytes: 100, hostRetainedBackingBytes: 100,
    pendingCloneReservedBytes: 0, admittedBoundBytes: 200, coverage: 'registered-solid-mesh-backings-only',
    unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] };
  const owner: AssemblyMeshOwnership = { document, library: EMPTY_PART_LIBRARY, activeDocumentId: document.id,
    documentVersion: 3, generation: 11, outcome: 'failed', timelineIndex: useAppStore.getState().timelineIndex,
    cancelRequestCount: 2, bodies, sources: new Map([['part-1', source]]), receipt,
    backingInspection: { status: 'known', hostEpoch: receipt.hostEpoch, inputBackingBytes: 0, additionalBackingBytes: 0,
      sameSourceBackings: [], coverage: 'registered-main-solid-backings-only', unobserved: receipt.unobserved },
    backingInspectionCurrent: () => current.membership,
    uiSnapshot: { epoch: assemblyUiBackings.epoch(), buffers: [] },
    receiptCurrent: () => current.ledger, publicationCurrent: () => current.publication };
  const state = { ...useAppStore.getState(), assembly: document, drawing: null, assemblyLibrary: owner.library,
    activeDocumentId: owner.activeDocumentId, documentVersion: owner.documentVersion,
    requestedGeneration: owner.generation, completedGeneration: owner.generation, cancelRequestCount: 2,
    recomputeCancelled: false, lastOutcome: 'failed' as const,
    assemblyView: { sourceDocument: document, resolved: { parts: new Map(), placements, partKeys, errors: [] },
      bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), meshOwnership: owner } };
  const bundle = buildAssemblyGeometry({ sourceDocument: document, components: document.components, bodies,
    placements, partKeys, hoveredComponentId: null, selectedComponentIds: [] });
  return { state, owner, source, bundle, body, current };
}

describe('Assembly current ownership boundary (metadata only)', () => {
  it('keeps source generation7 distinct from Assembly11 and accepts source success despite mate outcome failure', () => {
    const f = fixture(), admission = captureAssemblyMeshAdmission(f.bundle, f.state);
    expect(admission).not.toBeNull();
    if (admission === null) throw new Error('missing metadata admission');
    expect(assemblyMeshBudget(admission, f.state)).toEqual({ limitBytes: 1000000, baselineBytes: 200, sourceUiBackings: new Set() });
    expect(f.source.result.generation).toBe(7);
  });
  it('checks the exact current owner of a nonvisible empty Part outside the drawing bundle', () => {
    const f = fixture(), hiddenDocument = createEmptyPartDocument(), hiddenBodies: readonly SolidBody[] = [];
    let hiddenCurrent = true;
    const hidden: AssemblySourceMeshOwner = { document: hiddenDocument, attachments: undefined,
      result: { ...resultFor(hiddenDocument), bodies: hiddenBodies }, bodies: hiddenBodies,
      layouts: [], displayOwner: null, hiddenOwners: [], current: () => hiddenCurrent };
    const bodies = new Map([...f.owner.bodies, ['hidden-part', hiddenBodies] as const]);
    const owner = { ...f.owner, bodies, sources: new Map([...f.owner.sources, ['hidden-part', hidden] as const]) };
    const state = { ...f.state, assemblyView: { ...f.state.assemblyView, bodies, meshOwnership: owner } };
    const bundle = buildAssemblyGeometry({ sourceDocument: owner.document, components: owner.document.components,
      bodies, placements: state.assemblyView.resolved.placements, partKeys: state.assemblyView.resolved.partKeys,
      hoveredComponentId: null, selectedComponentIds: [] });
    expect(bundle.parts.map(part => part.partKey)).not.toContain('hidden-part');
    const admission = captureAssemblyMeshAdmission(bundle, state);
    if (admission === null) throw new Error('Current hidden metadata owner');
    expect(currentAssemblyMeshAdmission(admission, state)).toBe(true);
    hiddenCurrent = false;
    expect(currentAssemblyMeshAdmission(admission, state)).toBe(false);
    expect(assemblyMeshBudget(admission, state)).toBeNull();
  });

  it('rejects requested-only movement with the same Doc/view/body Map', () => {
    const f = fixture(), admission = captureAssemblyMeshAdmission(f.bundle, f.state);
    if (admission === null) throw new Error('missing metadata admission');
    expect(currentAssemblyMeshAdmission(admission, { ...f.state, requestedGeneration: 12 })).toBe(false);
  });
  it.each(['source', 'ledger', 'publication', 'membership'] as const)('rejects stale actual %s evidence', field => {
    const f = fixture(), admission = captureAssemblyMeshAdmission(f.bundle, f.state);
    if (admission === null) throw new Error('missing metadata admission');
    f.current[field] = false;
    expect(currentAssemblyMeshAdmission(admission, f.state)).toBe(false);
    expect(assemblyMeshBudget(admission, f.state)).toBeNull();
  });
  it('rejects new Doc/library/body layout identities in the same generation', () => {
    const f = fixture(), admission = captureAssemblyMeshAdmission(f.bundle, f.state);
    if (admission === null) throw new Error('missing metadata admission');
    expect(currentAssemblyMeshAdmission(admission, { ...f.state, assembly: { ...f.owner.document } })).toBe(false);
    expect(currentAssemblyMeshAdmission(admission, { ...f.state, assemblyLibrary: { ...f.owner.library } })).toBe(false);
    Object.defineProperty(f.body.mesh, 'positions', { value: new Float32Array(f.body.mesh.positions), configurable: true });
    expect(currentAssemblyMeshAdmission(admission, f.state)).toBe(false);
  });
  it('rejects local bodies without an actual source receipt instead of disguising them as world', () => {
    const f = fixture();
    const local: SolidBody = { ...f.body, coordinateFrame: { space: 'local', origin: [1e9, 0, 0],
      maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000000 } };
    const localResult = { ...f.source.result, bodies: [local] };
    const bodies = new Map([['part-1', localResult.bodies]]);
    const source = { ...f.source, result: localResult, bodies: localResult.bodies, layouts: [captureMeshBodyLayout(local)] };
    const owner = { ...f.owner, bodies, sources: new Map([['part-1', source]]) };
    const state = { ...f.state, assemblyView: { ...f.state.assemblyView, bodies, meshOwnership: owner } };
    const bundle = buildAssemblyGeometry({ sourceDocument: owner.document, components: owner.document.components,
      bodies, placements: state.assemblyView.resolved.placements, partKeys: state.assemblyView.resolved.partKeys,
      hoveredComponentId: null, selectedComponentIds: [] });
    expect(captureAssemblyMeshAdmission(bundle, state)).toBeNull();
  });
});

describe('exact publication refresh boundary (metadata only)', () => {
  it('allows identifying the same publication with stale evidence while refusing admission', () => {
    const f = fixture(); f.current.ledger = false; f.current.membership = false;
    expect(currentAssemblyMeshPublication(f.owner, f.state)).toBe(true);
    expect(captureAssemblyMeshAdmission(f.bundle, f.state)).toBeNull();
  });
  it('rejects request, cancellation, Doc, library and publication-owner replacement before refresh', () => {
    const f = fixture();
    expect(currentAssemblyMeshPublication(f.owner, { ...f.state, requestedGeneration: 12 })).toBe(false);
    expect(currentAssemblyMeshPublication(f.owner, { ...f.state, cancelRequestCount: 3 })).toBe(false);
    expect(currentAssemblyMeshPublication(f.owner, { ...f.state, recomputeCancelled: true })).toBe(false);
    expect(currentAssemblyMeshPublication(f.owner, { ...f.state, assembly: { ...f.owner.document } })).toBe(false);
    expect(currentAssemblyMeshPublication(f.owner, { ...f.state, assemblyLibrary: { ...f.owner.library } })).toBe(false);
    expect(currentAssemblyMeshPublication(f.owner, { ...f.state,
      assemblyView: { ...f.state.assemblyView, meshOwnership: { ...f.owner } } })).toBe(false);
  });
  it('rejects source teardown or replaced mesh layouts even when the old publication closure stays true', () => {
    const f = fixture(); f.current.source = false;
    expect(currentAssemblyMeshPublication(f.owner, f.state)).toBe(false);
    f.current.source = true;
    Object.defineProperty(f.body.mesh, 'positions', { value: new Float32Array(f.body.mesh.positions), configurable: true });
    expect(currentAssemblyMeshPublication(f.owner, f.state)).toBe(false);
  });
  it('does not use optional refresh support as substitute receipt evidence', async () => {
    const f = fixture(); f.current.ledger = false;
    const owner: AssemblyMeshOwnership = { ...f.owner, refreshOwnership: expected => {
      if (expected !== owner) return Promise.resolve(null);
      return Promise.resolve(null);
    } };
    const state = { ...f.state, assemblyView: { ...f.state.assemblyView, meshOwnership: owner } };
    expect(currentAssemblyMeshPublication(owner, state)).toBe(true);
    expect(captureAssemblyMeshAdmission(f.bundle, state)).toBeNull();
    expect(await owner.refreshOwnership?.(f.owner)).toBeNull();
    expect(await owner.refreshOwnership?.(owner)).toBeNull();
  });
});

type IssuedOwner = Extract<AssemblyMeshOwnership['receipt'], { readonly status: 'known' }>['owners'][number];

/** Metadata-only boundary fixture of `count` parts, one display owner each, issued by one receipt (EX12 W02). */
function manyPartsFixture(count: number) {
  const parts = Array.from({ length: count }, (_, index) => {
    const part = createEmptyPartDocument(), key = `part-${String(index)}`;
    const body: SolidBody = { featureId: `body-${String(index)}`, isValid: true, volume: 0, faces: [], edges: [], vertices: [], threadMarks: [],
      mesh: { positions: new Float32Array([index, 0, 0, index + 1, 0, 0, index, 1, 0]), normals: new Float32Array(9),
        indices: new Uint32Array([0, 1, 2]), edgePositions: new Float32Array(0), triangleCount: 1 } };
    const result = { ...resultFor(part), bodies: [body], generation: 7 };
    const displayOwner: IssuedOwner = Object.freeze({ dispatchId: `display-${String(index)}`, partId: key, generation: 7,
      kind: 'display', steps: Object.freeze([Object.freeze({ id: body.featureId, key: `key-${String(index)}` })]) });
    const source: AssemblySourceMeshOwner = { document: part, attachments: undefined, result, bodies: result.bodies,
      layouts: result.bodies.map(captureMeshBodyLayout), displayOwner, hiddenOwners: [], current: () => true };
    const component = { id: `component-${String(index)}`, name: key, source: { kind: 'part' as const, partRef: key },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false };
    return { key, source, displayOwner, component };
  });
  const document = { ...createAssemblyDocument('admission-1000'), components: parts.map(entry => entry.component) };
  const bodies = new Map(parts.map(entry => [entry.key, entry.source.bodies] as const));
  const placements = new Map(parts.map(entry => [entry.component.id, IDENTITY_PLACEMENT] as const));
  const partKeys = new Map(parts.map(entry => [entry.component.id, entry.key] as const));
  const sources = new Map(parts.map(entry => [entry.key, entry.source] as const));
  const receiptOf = (owners: readonly IssuedOwner[]): AssemblyMeshOwnership['receipt'] => Object.freeze({
    status: 'known', observationId: 'metadata-1000', hostEpoch: 2,
    workerEpochs: Object.freeze([Object.freeze({ providerId: 1, connectionEpoch: 1, cache: 2, owners: 2 })]), owners,
    limitBytes: 1000000, workerRetainedBackingBytes: 100, hostRetainedBackingBytes: 100,
    pendingCloneReservedBytes: 0, admittedBoundBytes: 200, coverage: 'registered-solid-mesh-backings-only',
    unobserved: Object.freeze(['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] as const) });
  const ownerOf = (receipt: AssemblyMeshOwnership['receipt']): AssemblyMeshOwnership => ({ document, library: EMPTY_PART_LIBRARY,
    activeDocumentId: document.id, documentVersion: 3, generation: 11, outcome: 'success', timelineIndex: useAppStore.getState().timelineIndex,
    cancelRequestCount: 2, bodies, sources, receipt,
    backingInspection: { status: 'known', hostEpoch: 2, inputBackingBytes: 0, additionalBackingBytes: 0,
      sameSourceBackings: [], coverage: 'registered-main-solid-backings-only', unobserved: ['native', 'gpu', 'wasm', 'mesh-metadata', 'other-providers'] },
    backingInspectionCurrent: () => true, uiSnapshot: { epoch: assemblyUiBackings.epoch(), buffers: [] },
    receiptCurrent: () => true, publicationCurrent: () => true });
  const stateOf = (owner: AssemblyMeshOwnership) => ({ ...useAppStore.getState(), assembly: document, drawing: null,
    assemblyLibrary: owner.library, activeDocumentId: owner.activeDocumentId, documentVersion: owner.documentVersion,
    requestedGeneration: owner.generation, completedGeneration: owner.generation, cancelRequestCount: 2,
    recomputeCancelled: false, lastOutcome: 'success' as const,
    assemblyView: { sourceDocument: document, resolved: { parts: new Map(), placements, partKeys, errors: [] },
      bodies, appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), meshOwnership: owner } });
  const bundle = buildAssemblyGeometry({ sourceDocument: document, components: document.components, bodies,
    placements, partKeys, hoveredComponentId: null, selectedComponentIds: [] });
  const admitted = (owners: readonly IssuedOwner[]): boolean => {
    const owner = ownerOf(receiptOf(owners)), state = stateOf(owner);
    const admission = captureAssemblyMeshAdmission(bundle, state);
    return admission !== null && currentAssemblyMeshAdmission(admission, state);
  };
  return { issued: Object.freeze(parts.map(entry => entry.displayOwner)), receiptOf, ownerOf, stateOf, bundle, admitted };
}

describe('EX12 W02: 1,000 distinct part sources against one issued receipt (metadata only)', () => {
  it('keeps the recorded admission decisions of 1,000 sources: accepted and each refusal reason', () => {
    const f = manyPartsFixture(1_000), issued = f.issued;
    const replace = (index: number, change: (owner: IssuedOwner) => IssuedOwner): readonly IssuedOwner[] =>
      Object.freeze(issued.map((owner, at) => at === index ? change(owner) : owner));
    const first = issued[0];
    if (first === undefined) throw new Error('Issued fixture owner');
    // Recorded with the linear search before the W02 change (W02 final.md §4); the same input keeps the same decision.
    const decisions = {
      allIssued: f.admitted(issued),
      reversedOrder: f.admitted(Object.freeze([...issued].reverse())),
      extraSameIdWrongPart: f.admitted(Object.freeze([...issued, Object.freeze({ ...first, partId: 'part-other' })])),
      missingOne: f.admitted(Object.freeze(issued.filter((_, index) => index !== 500))),
      otherStepKey: f.admitted(replace(500, owner => Object.freeze({ ...owner,
        steps: Object.freeze([Object.freeze({ id: owner.steps[0]?.id ?? '', key: 'other' })]) }))),
      otherStepCount: f.admitted(replace(250, owner => Object.freeze({ ...owner, steps: Object.freeze([]) }))),
      otherGeneration: f.admitted(replace(999, owner => Object.freeze({ ...owner, generation: 8 }))),
      otherPart: f.admitted(replace(0, owner => Object.freeze({ ...owner, partId: 'part-x' }))),
      hiddenKind: f.admitted(replace(250, owner => Object.freeze({ ...owner, kind: 'hidden' }))),
      empty: f.admitted(Object.freeze([])),
    };
    expect(decisions).toEqual({ allIssued: true, reversedOrder: true, extraSameIdWrongPart: true, missingOne: false,
      otherStepKey: false, otherStepCount: false, otherGeneration: false, otherPart: false, hiddenKind: false, empty: false });
  });
  it('rebuilds the issued-owner lookup only for another receipt list, and never keeps one for a list that can change', () => {
    const f = manyPartsFixture(1_000), all = f.issued, seventh = all[7];
    if (seventh === undefined) throw new Error('Issued fixture owner');
    expect(f.admitted(all)).toBe(true);
    expect(f.admitted(Object.freeze(all.filter((_, index) => index !== 7)))).toBe(false);
    expect(f.admitted(all)).toBe(true); // The first list's lookup still answers for the first list.
    const open = [...all]; // An unfrozen list may change after a check, so it is read again every time.
    expect(f.admitted(open)).toBe(true);
    open.splice(7, 1);
    expect(f.admitted(open)).toBe(false);
    open.splice(7, 0, seventh);
    expect(f.admitted(open)).toBe(true);
  });
  it('leaves the borrowed receipt, owners and sources unchanged over 200 repeated checks (§10.424)', () => {
    const f = manyPartsFixture(1_000), owner = f.ownerOf(f.receiptOf(f.issued)), state = f.stateOf(owner);
    const snapshot = () => JSON.stringify({ receipt: owner.receipt, sources: [...owner.sources].map(([key, source]) =>
      [key, source.displayOwner, source.hiddenOwners, source.result.generation, source.bodies.length]) });
    const before = snapshot();
    const admission = captureAssemblyMeshAdmission(f.bundle, state);
    if (admission === null) throw new Error('1,000-source metadata admission');
    for (let check = 0; check < 200; check += 1) expect(currentAssemblyMeshAdmission(admission, state)).toBe(true);
    expect(snapshot()).toBe(before);
    expect(Object.isFrozen(owner.receipt)).toBe(true);
    expect(owner.receipt.status === 'known' && Object.isFrozen(owner.receipt.owners)).toBe(true);
    expect(Object.keys(owner.receipt)).toEqual(Object.keys(f.receiptOf(f.issued)));
    expect(assemblyMeshBudget(admission, state)).toEqual({ limitBytes: 1000000, baselineBytes: 200, sourceUiBackings: new Set() });
  });
});
