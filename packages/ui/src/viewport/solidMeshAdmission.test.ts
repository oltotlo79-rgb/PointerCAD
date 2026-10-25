import { type PartRecomputeResult, type SolidBody } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { createNumericInput } from '../sketch/numericInput.js';
import type { AppState } from '../store/appState.js';
import { accountingSnapshot, captureMeshBodyLayout, captureStagedSolidOwnership, type MeshJsAccountingState,
  type PartStager, type StagedSolidState } from '../store/recomputeSlice.js';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { captureSolidMeshAdmission, captureWorldMeshAdmission, createGpuMeshBudget, displayCopyBaseline,
  isSolidMeshAdmissionCurrent,
  solidBodiesForAdmission, solidMeshOwnershipChanged } from './solidMeshAdmission.js';

beforeEach(resetTestStore);

/** Post-token union after the request token: 160 Worker-retained bytes plus a 60-byte reply clone. */
const FINAL = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 0,
  cacheProtectedBytes: 100, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 160,
  replyCloneReservedBytes: 60 };

function fixture(): AppState {
  const initial = useAppStore.getState();
  const document = { ...initial.document, id: 'model-D' };
  const body: SolidBody = { ...bodyFor('triangle'), coordinateFrame: { space: 'local',
    origin: [1e9 + 1, 0, 0], maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000 } };
  const bodies = [body];
  const accounting: MeshJsAccountingState = { document, timelineIndex: null, outcome: 'success', activeDocumentId: 'session-S', bodies, bodyLayouts: bodies.map(captureMeshBodyLayout),
    receipt: { documentId: 'model-D', partId: 'part-D', generation: 7,
      reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 100,
        cacheProtectedBytes: 200, retainedReplyBytes: 200, requestPeakReservedBytes: 900 },
      final: FINAL } };
  return { ...initial, document, activeDocumentId: 'session-S', bodies, meshJsAccounting: accounting,
    requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success', recomputeCancelled: false,
    timelineIndex: null, assembly: null, drawing: null, sheetMetalPreview: null, sheetMetalTool: null };
}

describe('solid mesh admission ownership', () => {
  it('admits distinct session/model/part IDs and keeps the exact source/layout identities', () => {
    const state = fixture(), admission = captureSolidMeshAdmission(state);
    expect(admission?.bodies).toBe(state.bodies);
    expect(admission?.accounting).toBe(state.meshJsAccounting);
    if (admission === null) throw new Error('missing admission');
    expect(isSolidMeshAdmissionCurrent(admission, state)).toBe(true);
    expect(admission.state).not.toBe(state);
    expect(Object.keys(admission.state ?? {})).not.toContain('undoStack');
  });

  it.each(['bodies', 'requested', 'completed', 'outcome', 'cancel', 'history', 'document', 'session', 'receipt'] as const)(
    'rejects %s with unchanged mesh bytes', scenario => {
      const state = fixture(), admission = captureSolidMeshAdmission(state);
      if (admission === null) throw new Error('missing admission');
      let next = state;
      if (scenario === 'bodies') next = { ...state, bodies: [...state.bodies] };
      if (scenario === 'requested') next = { ...state, requestedGeneration: 8 };
      if (scenario === 'completed') next = { ...state, completedGeneration: 6 };
      if (scenario === 'outcome') next = { ...state, lastOutcome: 'failed' };
      if (scenario === 'cancel') next = { ...state, cancelRequestCount: state.cancelRequestCount + 1, meshJsAccounting: null };
      if (scenario === 'history') next = { ...state, timelineIndex: 0 };
      if (scenario === 'document') next = { ...state, document: { ...state.document, id: 'model-E' } };
      if (scenario === 'session') next = { ...state, activeDocumentId: 'session-T' };
      if (scenario === 'receipt') next = { ...state, meshJsAccounting: null };
      expect(solidMeshOwnershipChanged(next, state)).toBe(true);
      expect(isSolidMeshAdmissionCurrent(admission, next)).toBe(false);
      expect(captureSolidMeshAdmission(next)).toBeNull();
    },
  );

  it('recaptures an appearance/name-only document while requiring exact current document at commit', () => {
    const state = fixture(), first = captureSolidMeshAdmission(state);
    if (first === null) throw new Error('missing admission');
    const next = { ...state, document: { ...state.document, name: '外観だけの文書' } };
    expect(isSolidMeshAdmissionCurrent(first, next)).toBe(false);
    const current = captureSolidMeshAdmission(next);
    expect(current).not.toBeNull();
    if (current === null) throw new Error('missing recapture');
    expect(isSolidMeshAdmissionCurrent(current, next)).toBe(true);
  });

  it('does not authorize a different preview array with the main receipt; world previews retain their path', () => {
    const state = fixture();
    const session: NonNullable<AppState['sheetMetalTool']> = { id: 'preview', kind: 'sheetBase',
      document: state.document, documentId: state.activeDocumentId };
    const preview: NonNullable<AppState['sheetMetalPreview']> = { session, candidate: state.document,
      bodies: [...state.bodies], featureId: 'triangle', volume: 1 };
    const localPreview = { ...state, sheetMetalTool: session, sheetMetalPreview: preview };
    expect(solidBodiesForAdmission(localPreview)).toBe(preview.bodies);
    expect(captureSolidMeshAdmission(localPreview)).toBeNull();
    const worldBodies = [bodyFor('world-preview')];
    const worldPreview = { ...localPreview, sheetMetalPreview: { ...preview, bodies: worldBodies } };
    expect(captureSolidMeshAdmission(worldPreview)?.bodies).toBe(worldBodies);
  });

  it.each(['origin', 'budget', 'positions', 'normals', 'indices', 'edges'] as const)(
    'rejects a layout change in %s after capture', scenario => {
      const state = fixture(), admission = captureSolidMeshAdmission(state), body = state.bodies[0];
      if (admission === null || body.coordinateFrame === undefined) throw new Error('missing admission/frame');
      if (scenario === 'origin') Object.defineProperty(body.coordinateFrame, 'origin', { value: [1e9 + 2, 0, 0] });
      if (scenario === 'budget') Object.defineProperty(body.coordinateFrame, 'maximumLiveMeshBytes', { value: 999 });
      if (scenario === 'positions') Object.defineProperty(body.mesh, 'positions', { value: new Float32Array(body.mesh.positions) });
      if (scenario === 'normals') Object.defineProperty(body.mesh, 'normals', { value: new Float32Array(body.mesh.normals) });
      if (scenario === 'indices') Object.defineProperty(body.mesh, 'indices', { value: new Uint32Array(body.mesh.indices) });
      if (scenario === 'edges') Object.defineProperty(body.mesh, 'edgePositions', { value: new Float32Array(body.mesh.edgePositions) });
      expect(isSolidMeshAdmissionCurrent(admission, state)).toBe(false);
    },
  );

  it('uses the adoption-time frame snapshot before the first viewport capture', () => {
    const state = fixture(), frame = state.bodies[0].coordinateFrame;
    if (frame === undefined) throw new Error('missing frame');
    Object.defineProperty(frame, 'origin', { value: [1e9 + 2, 0, 0] });
    expect(captureSolidMeshAdmission(state)).toBeNull();
  });

  it('requires a valid post-token union within the limit and never treats a missing one as zero', () => {
    const state = fixture(), accounting = state.meshJsAccounting;
    if (accounting === null) throw new Error('missing receipt');
    const withFinal = (final: typeof FINAL | undefined): AppState => ({ ...state, meshJsAccounting: {
      ...accounting, receipt: { ...accounting.receipt, final } } });
    expect(captureSolidMeshAdmission(withFinal(undefined))).toBeNull();
    // 940 Worker-retained bytes (cache 880 plus the 60-byte local reply) and a 60-byte clone fill 1000.
    const atLimit = { ...FINAL, cacheActiveBytes: 880, cacheProtectedBytes: 880, retainedBackingBytes: 940 };
    expect(captureSolidMeshAdmission(withFinal(atLimit))?.bodies).toBe(state.bodies);
    for (const forged of [
      { ...atLimit, cacheActiveBytes: 881, retainedBackingBytes: 941 },
      { ...FINAL, replyCloneReservedBytes: 59 },
      { ...FINAL, cacheProtectedBytes: 101 },
      { ...FINAL, retainedBackingBytes: 99 },
      { ...FINAL, displayBackingBytes: 161 },
      { ...FINAL, retainedBackingBytes: 221 },
      { ...FINAL, limitBytes: 999 },
      { ...FINAL, cacheRetiredBytes: Number.NaN },
      { ...FINAL, retainedBackingBytes: Number.MAX_SAFE_INTEGER },
    ]) expect(captureSolidMeshAdmission(withFinal(forged))).toBeNull();
  });

  it('rejects a frame/receipt budget mismatch without claiming GPU or RSS measurement', () => {
    const state = fixture(), body = state.bodies[0], accounting = state.meshJsAccounting;
    if (body.coordinateFrame === undefined || accounting === null) throw new Error('missing frame/receipt');
    const bodies = [{ ...body, coordinateFrame: { ...body.coordinateFrame, maximumLiveMeshBytes: 999 } }];
    expect(captureSolidMeshAdmission({ ...state, bodies, meshJsAccounting: { ...accounting, bodies,
      bodyLayouts: bodies.map(captureMeshBodyLayout) } })).toBeNull();
    expect(captureWorldMeshAdmission(state.bodies)).toBeNull();
    const world = captureWorldMeshAdmission([bodyFor('world')]);
    expect(world).not.toBeNull();
    if (world === null) throw new Error('missing world admission');
    expect(isSolidMeshAdmissionCurrent(world)).toBe(true);
  });
});

describe('display copy baseline and shared GPU mesh budget', () => {
  it('takes the baseline from the post-token union plus the reply clone, never from a missing union', () => {
    const accounting = fixture().meshJsAccounting;
    if (accounting === null) throw new Error('missing receipt');
    expect(displayCopyBaseline(accounting)).toEqual({ limitBytes: 1000, baselineBytes: 160 + 60 });
    expect(displayCopyBaseline({ ...accounting, receipt: { ...accounting.receipt, final: undefined } })).toBeNull();
    expect(displayCopyBaseline({ ...accounting, receipt: { ...accounting.receipt,
      final: { ...FINAL, replyCloneReservedBytes: 59 } } })).toBeNull();
  });

  it('replaces, refuses and releases reservations per owner without touching another owner', () => {
    const pool = createGpuMeshBudget(100);
    const a = Symbol('a'), b = Symbol('b');
    expect(pool.reserve(a, 60)).toBe(true);
    expect(pool.reserve(b, 41)).toBe(false);
    expect(pool.reservedBytes()).toBe(60);
    expect(pool.reserve(b, 40)).toBe(true);
    expect(pool.reserve(a, 10)).toBe(true);
    expect(pool.reservedBytes()).toBe(50);
    pool.release(b);
    pool.release(b);
    expect(pool.reservedBytes()).toBe(10);
    expect(pool.reservedBytes(a)).toBe(10);
    expect(pool.reservedBytes(b)).toBe(0);
    for (const bad of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) expect(pool.reserve(a, bad)).toBe(false);
    expect(pool.reservedBytes(a)).toBe(10);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => createGpuMeshBudget(bad)).toThrow(RangeError);
  });
});

describe('staged extrusion preview admission (EX-14)', () => {
  /** A ready staged result with its own receipt, owned by a stub stager (the scheduler is tested in extrudePreview.test.ts). */
  function stagedFixture() {
    const base = fixture();
    let owned: StagedSolidState | null = null;
    const stager: PartStager = { stage: () => null, confirm: () => 'refused', cancel: () => undefined,
      owns: (staged) => staged === owned };
    const open: AppState = { ...base, partStager: stager, numericInput: createNumericInput('extrude', 'extrudeDistance') };
    const ownership = captureStagedSolidOwnership(open, stager, 1);
    if (ownership === null) throw new Error('A part document with an open input must be ownable');
    const prepared = { ...base.document, solids: [...base.document.solids] };
    const preview: SolidBody = { ...bodyFor('preview'), coordinateFrame: { space: 'local',
      origin: [2, 0, 0], maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000 } };
    const result: PartRecomputeResult = { ...resultFor(prepared), generation: 9, bodies: [preview],
      meshJsAccounting: { documentId: prepared.id, partId: 'part-D', generation: 9,
        reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 100,
          cacheProtectedBytes: 200, retainedReplyBytes: 200, requestPeakReservedBytes: 900 }, final: FINAL } };
    const receipt = result.meshJsAccounting;
    if (receipt === undefined) throw new Error('fixture receipt');
    const staged: StagedSolidState = Object.freeze({ ownership, fingerprint: 'k', finalFeatureId: 'preview',
      placement: { document: prepared, timelineIndex: null, inserted: false }, displayed: prepared, status: 'ready',
      result, accounting: accountingSnapshot(prepared, null, open.activeDocumentId, result, receipt),
      wholeGeneration: null, errors: [], errorMessage: null, failure: null, confirmRequested: false });
    owned = staged;
    return { state: { ...open, stagedSolid: staged }, staged, release: () => { owned = null; } };
  }

  it('shows the staged bodies with the staged receipt only, leaving the committed receipt and generations alone', () => {
    const { state, staged } = stagedFixture();
    expect(solidBodiesForAdmission(state)).toBe(staged.result?.bodies);
    const admission = captureSolidMeshAdmission(state);
    if (admission === null) throw new Error('missing staged admission');
    expect(admission.bodies).toBe(staged.result?.bodies);
    expect(admission.accounting).toBe(staged.accounting);
    expect(admission.accounting).not.toBe(state.meshJsAccounting);
    expect(admission.state?.stagedSolid).toBe(staged);
    expect(admission.state?.requestedGeneration).toBe(7);
    expect(isSolidMeshAdmissionCurrent(admission, state)).toBe(true);
    if (admission.accounting === null) throw new Error('missing staged receipt');
    expect(displayCopyBaseline(admission.accounting)).toEqual({ limitBytes: 1000, baselineBytes: 160 + 60 });
  });

  it.each(['selection', 'input', 'released', 'failed', 'document', 'history'] as const)(
    'returns to the committed display when the staged preview loses %s', (scenario) => {
      const { state, staged, release } = stagedFixture();
      const admission = captureSolidMeshAdmission(state);
      if (admission === null) throw new Error('missing staged admission');
      let next: AppState = state;
      if (scenario === 'selection') next = { ...state, selection: [...state.selection] };
      if (scenario === 'input') next = { ...state, numericInput: null };
      if (scenario === 'released') release();
      if (scenario === 'failed') next = { ...state, stagedSolid: { ...staged, status: 'failed', result: null, accounting: null, failure: 'failed' } };
      if (scenario === 'document') next = { ...state, document: { ...state.document } };
      if (scenario === 'history') next = { ...state, undoStack: { ...state.undoStack } };
      expect(isSolidMeshAdmissionCurrent(admission, next)).toBe(false);
      if (scenario !== 'released') expect(solidMeshOwnershipChanged(next, state)).toBe(true);
      if (scenario !== 'document') expect(solidBodiesForAdmission(next)).toBe(next.bodies);
    });

  it('never relabels another receipt for the staged bodies', () => {
    const { state, staged } = stagedFixture();
    const accounting = staged.accounting;
    if (accounting === null) throw new Error('missing staged receipt');
    for (const forged of [
      { ...accounting, receipt: { ...accounting.receipt, generation: 7 } },
      { ...accounting, receipt: { ...accounting.receipt, final: undefined } },
      { ...accounting, document: state.document },
      { ...accounting, bodies: state.bodies },
    ]) {
      const next = { ...state, stagedSolid: { ...staged, accounting: forged } };
      // The stub stager owns only the original staged object, so the forged copy is also not current.
      expect(captureSolidMeshAdmission(next)?.accounting ?? null).not.toBe(forged);
    }
    expect(captureSolidMeshAdmission({ ...state, stagedSolid: { ...staged } })?.bodies).toBe(state.bodies);
  });
});

describe('main-realm imported mesh accounting', () => {
  function meshFixture() {
    const state = fixture();
    const accounting = state.meshJsAccounting;
    if (accounting === null) throw new Error('missing fixture accounting');
    const backing = new ArrayBuffer(120);
    const body: SolidBody = { ...state.bodies[0], bodyKind: 'mesh', mesh: { positions: new Float32Array(backing, 0, 9),
      normals: new Float32Array(backing, 36, 9), indices: new Uint32Array(backing, 72, 3),
      edgePositions: new Float32Array(0), triangleCount: 1 } };
    const bodies = [body];
    const result = { ...state, bodies, meshJsAccounting: { ...accounting, bodies,
      bodyLayouts: bodies.map(captureMeshBodyLayout), mainMeshBacking: { buffers: [backing], retainedBackingBytes: 120, limitBytes: 1120 } } };
    return { state: result, backing };
  }
  it('counts a shared backing once and adds it to the unchanged Worker union', () => {
    const { state } = meshFixture();
    expect(displayCopyBaseline(state.meshJsAccounting)).toEqual({ limitBytes: 1120, baselineBytes: 340 });
    expect(state.meshJsAccounting.receipt.final).toBe(FINAL);
    const admission = captureSolidMeshAdmission(state);
    expect(admission).not.toBeNull();
    if (admission === null) throw new Error('missing admission');
    expect(isSolidMeshAdmissionCurrent(admission, { ...state, requestedGeneration: 8 })).toBe(false);
    expect(isSolidMeshAdmissionCurrent(admission, { ...state, cancelRequestCount: state.cancelRequestCount + 1 })).toBe(false);
  });
  it.each(['missing', 'duplicate', 'wrong-bytes', 'wrong-limit', 'unregistered', 'over-512'] as const)(
    'refuses %s main backing evidence without weakening Worker checks', scenario => {
      const { state, backing } = meshFixture();
      const accounting = state.meshJsAccounting;
      let main = accounting.mainMeshBacking;
      if (scenario === 'duplicate') main = { ...main, buffers: [backing, backing] };
      if (scenario === 'wrong-bytes') main = { ...main, retainedBackingBytes: 119 };
      if (scenario === 'wrong-limit') main = { ...main, limitBytes: 1121 };
      if (scenario === 'unregistered') main = { ...main, buffers: [new ArrayBuffer(120)] };
      if (scenario === 'over-512') main = { ...main, limitBytes: 512 * 1024 * 1024 + 1 };
      const altered = scenario === 'missing' ? { ...accounting, mainMeshBacking: undefined } : { ...accounting, mainMeshBacking: main };
      expect(displayCopyBaseline(altered)).toBeNull();
      expect(captureSolidMeshAdmission({ ...state, meshJsAccounting: altered })).toBeNull();
    });
});
