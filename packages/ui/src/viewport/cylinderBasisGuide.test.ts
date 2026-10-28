import { beforeEach, describe, expect, it } from 'vitest';
import type { SolidBody, SolidFaceEntry } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { accountingSnapshot, captureMeshBodyLayout, captureStagedSolidOwnership, type PartStager, type StagedSolidState } from '../store/recomputeSlice.js';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { cylinderBasisGuide, cylinderBasisSegment, isCylinderBasisGuideCurrent } from './cylinderBasisGuide.js';
import { captureSolidMeshAdmission } from './solidMeshAdmission.js';

beforeEach(resetTestStore);
function face(): SolidFaceEntry {
  return { index: 0, surfaceKind: 'cylinder', area: 800 * Math.PI, centroid: [13, -17, 38],
    axis: [0, 0, -1], radius: 10, triangleOffset: 0, triangleCount: 1,
    cylinderBasis: { origin: [13, -17, 18], axis: [0, 0, 1], zeroDirection: [0, 1, 0], axialRange: [0, 40] } };
}
function fixture(): AppState {
  const initial = useAppStore.getState(), document = initial.document;
  const body: SolidBody = { ...bodyFor('cylinder'), faces: [face()], coordinateFrame: { space: 'local',
    origin: [13, -17, 18], maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000 } };
  const bodies = [body];
  return { ...initial, document, activeDocumentId: 'session', bodies, selection: ['cylinder#face:0'],
    assembly: null, drawing: null, stagedSolid: null, sheetMetalTool: null, sheetMetalPreview: null,
    requestedGeneration: 7, completedGeneration: 7, lastOutcome: 'success', isComputing: false, recomputeCancelled: false,
    timelineIndex: null, mathGeometryResult: { document, generation: 7, evaluated: true, outcomes: new Map() },
    meshJsAccounting: { document, bodies, bodyLayouts: bodies.map(captureMeshBodyLayout), activeDocumentId: 'session',
      timelineIndex: null, outcome: 'success', receipt: { documentId: document.id, partId: 'part-native', generation: 7,
        reading: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 100,
          cacheProtectedBytes: 200, retainedReplyBytes: 200, requestPeakReservedBytes: 900 },
        final: { status: 'known', limitBytes: 1000, cacheActiveBytes: 100, cacheRetiredBytes: 0,
          cacheProtectedBytes: 100, displayBackingBytes: 60, replyBackingBytes: 60, retainedBackingBytes: 160,
          replyCloneReservedBytes: 60 } } } };
}

describe('current native cylinder basis guide', () => {
  it('uses native zero direction instead of world X or the material-oriented axis', () => {
    const state = fixture(), guide = cylinderBasisGuide(state, '0°');
    expect(guide?.drawing.result.segment).toEqual([[13, -17, 38], [13, -7, 38]]);
    if (guide === null) throw new Error('Missing valid guide');
    expect(guide.admission.accounting).toBe(state.meshJsAccounting);
    expect(isCylinderBasisGuideCurrent(guide, state)).toBe(true);
  });

  it.each(['missing receipt', 'wrong generation', 'invalid budget', 'missing final', 'wrong outcome',
    'cancelled', 'computing', 'stale math', 'no math', 'multiple', 'no selection', 'timeline', 'other session',
    'different bodies', 'world without receipt'])(
    'refuses %s independently of unchanged shape bytes', scenario => {
      const state = fixture(), guide = cylinderBasisGuide(state, '0°'), accounting = state.meshJsAccounting;
      if (guide === null || accounting === null) throw new Error('Missing fixture admission');
      const before = Array.from(state.bodies[0].mesh.positions);
      let next = state;
      if (scenario === 'missing receipt') next = { ...state, meshJsAccounting: null };
      if (scenario === 'wrong generation') next = { ...state, meshJsAccounting: { ...accounting,
        receipt: { ...accounting.receipt, generation: 6 } } };
      if (scenario === 'invalid budget') next = { ...state, meshJsAccounting: { ...accounting,
        receipt: { ...accounting.receipt, reading: { ...accounting.receipt.reading, limitBytes: 999 } } } };
      if (scenario === 'missing final') next = { ...state, meshJsAccounting: { ...accounting,
        receipt: { ...accounting.receipt, final: undefined } } };
      if (scenario === 'wrong outcome') next = { ...state, lastOutcome: 'failed' };
      if (scenario === 'cancelled') next = { ...state, recomputeCancelled: true };
      if (scenario === 'computing') next = { ...state, isComputing: true };
      if (scenario === 'stale math') next = { ...state, mathGeometryResult: { document: state.document,
        generation: 6, evaluated: true, outcomes: new Map() } };
      if (scenario === 'no math') next = { ...state, mathGeometryResult: null };
      if (scenario === 'multiple') next = { ...state, selection: ['cylinder#face:0', 'cylinder#face:1'] };
      if (scenario === 'no selection') next = { ...state, selection: [] };
      if (scenario === 'timeline') next = { ...state, timelineIndex: 0 };
      if (scenario === 'other session') next = { ...state, activeDocumentId: 'other' };
      if (scenario === 'different bodies') next = { ...state, bodies: [...state.bodies] };
      if (scenario === 'world without receipt') {
        const bodies = state.bodies.map(body => ({ ...body, coordinateFrame: undefined }));
        next = { ...state, bodies, meshJsAccounting: null };
      }
      expect(cylinderBasisGuide(next, '0°')).toBeNull();
      expect(isCylinderBasisGuideCurrent(guide, next)).toBe(false);
      expect(Array.from(state.bodies[0].mesh.positions)).toEqual(before);
    });

  it('rejects a changed captured layout and a valid but different selection before drawing', () => {
    const state = fixture(), guide = cylinderBasisGuide(state, '0°');
    if (guide === null) throw new Error('Missing guide');
    expect(isCylinderBasisGuideCurrent(guide, { ...state, selection: [...state.selection] })).toBe(false);
    Object.defineProperty(state.bodies[0].mesh, 'positions', { value: new Float32Array(state.bodies[0].mesh.positions) });
    expect(isCylinderBasisGuideCurrent(guide, state)).toBe(false);
    expect(cylinderBasisGuide(state, '0°')).toBeNull();
  });

  it('rejects an otherwise admitted staged preview from a different generation', () => {
    const state = fixture(), guide = cylinderBasisGuide(state, '0°'), accounting = state.meshJsAccounting;
    if (guide === null || accounting === null) throw new Error('Missing fixture');
    let owned: StagedSolidState | null = null;
    const stager: PartStager = { stage: () => null, confirm: () => 'refused', cancel: () => undefined,
      owns: candidate => candidate === owned };
    const open = { ...state, partStager: stager, numericInput: createNumericInput('extrude', 'extrudeDistance') };
    const ownership = captureStagedSolidOwnership(open, stager, 1);
    if (ownership === null) throw new Error('Missing staged ownership');
    const prepared = { ...state.document, solids: [...state.document.solids] };
    const receipt = { ...accounting.receipt, generation: 9 };
    const result = { ...resultFor(prepared), generation: 9, bodies: [...state.bodies], meshJsAccounting: receipt };
    const staged: StagedSolidState = { ownership, fingerprint: 'preview', finalFeatureId: 'preview',
      placement: { document: prepared, timelineIndex: null, inserted: false }, displayed: prepared, status: 'ready', result,
      accounting: accountingSnapshot(prepared, null, open.activeDocumentId, result, receipt), wholeGeneration: null,
      errors: [], errorMessage: null, failure: null, confirmRequested: false };
    owned = staged;
    const next = { ...open, stagedSolid: staged };
    expect(captureSolidMeshAdmission(next)?.accounting).toBe(staged.accounting);
    expect(captureSolidMeshAdmission(next)?.bodies).toBe(result.bodies);
    expect(cylinderBasisGuide(next, '0°')).toBeNull();
    expect(isCylinderBasisGuideCurrent(guide, next)).toBe(false);
  });

  it('selection and guide recomputation keep document, history and shape bytes unchanged', () => {
    const state = fixture(); useAppStore.setState(state);
    const document = state.document, undo = state.undoStack, redo = state.undoStack.future;
    const bytes = Array.from(state.bodies[0].mesh.positions);
    const pastCount = state.undoStack.past.length, futureCount = state.undoStack.future.length;
    useAppStore.getState().setSelection([]);
    expect(cylinderBasisGuide(useAppStore.getState(), '0°')).toBeNull();
    useAppStore.getState().setSelection(['cylinder#face:0']);
    expect(cylinderBasisGuide(useAppStore.getState(), '0°')).not.toBeNull();
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(undo); expect(useAppStore.getState().undoStack.future).toBe(redo);
    expect(useAppStore.getState().undoStack.past).toHaveLength(pastCount);
    expect(useAppStore.getState().undoStack.future).toHaveLength(futureCount);
    expect(Array.from(useAppStore.getState().bodies[0].mesh.positions)).toEqual(bytes);
  });

  it.each(['missing', 'nan', 'zero axis', 'parallel', 'reversed extent', 'zero radius'])(
    'omits invalid basis data: %s', scenario => {
      const current = face(), basis = current.cylinderBasis;
      if (basis === undefined) throw new Error('Missing basis fixture');
      let invalid = current;
      if (scenario === 'missing') invalid = { ...current, cylinderBasis: undefined };
      if (scenario === 'nan') invalid = { ...current, cylinderBasis: { ...basis, origin: [Number.NaN, 0, 0] } };
      if (scenario === 'zero axis') invalid = { ...current, cylinderBasis: { ...basis, axis: [0, 0, 0] } };
      if (scenario === 'parallel') invalid = { ...current, cylinderBasis: { ...basis, zeroDirection: basis.axis } };
      if (scenario === 'reversed extent') invalid = { ...current, cylinderBasis: { ...basis, axialRange: [40, 0] } };
      if (scenario === 'zero radius') invalid = { ...current, radius: 0 };
      expect(cylinderBasisSegment(invalid)).toBeNull();
    });
});
