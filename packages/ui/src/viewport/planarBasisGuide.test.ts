import { beforeEach, describe, expect, it } from 'vitest';
import type { SolidBody, SolidFaceEntry } from '@pointercad/model';
import type { AppState } from '../store/appState.js';
import { accountingSnapshot, captureMeshBodyLayout, captureStagedSolidOwnership, type PartStager, type StagedSolidState } from '../store/recomputeSlice.js';
import { bodyFor, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { createNumericInput } from '../sketch/numericInput.js';
import { useAppStore } from '../store/useAppStore.js';
import { planarBasisGuide, planarBasisDrawings, isPlanarBasisGuideCurrent } from './planarBasisGuide.js';
import { captureSolidMeshAdmission } from './solidMeshAdmission.js';

beforeEach(resetTestStore);
const labels = { origin: '選択面の原点', x: '面内＋X（正方向）', y: '面内＋Y（正方向）' };
function face(): SolidFaceEntry {
  return { index: 0, surfaceKind: 'plane', area: 400, centroid: [100, 200, 300],
    axis: [-.48, .36, .8], radius: null, triangleOffset: 0, triangleCount: 1,
    planarBasis: { origin: [11, -7, 5], xAxis: [.6, .8, 0], normal: [-.48, .36, .8], yAxis: [-.64, .48, -.6] } };
}
function fixture(): AppState {
  const initial = useAppStore.getState(), document = initial.document;
  const body: SolidBody = { ...bodyFor('plane'), faces: [face()], coordinateFrame: { space: 'local',
    origin: [13, -17, 18], maximumFloat32ErrorMm: 0.01, maximumLiveMeshBytes: 1000 } };
  const bodies = [body];
  return { ...initial, document, activeDocumentId: 'session', bodies, selection: ['plane#face:0'],
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

describe('current native planar basis guide', () => {
  it('uses the independent rotated native origin and positive axes, including a trim-external origin', () => {
    const drawings = planarBasisDrawings(face(), labels);
    if (drawings === null) throw new Error('Missing planar drawings');
    expect(drawings[0].result.segment).toEqual([[11, -7, 5], [11, -7, 5]]);
    expect(drawings[1].result.segment).toEqual([[11, -7, 5], [14, -3, 5]]);
    expect(drawings[2].result.segment).toEqual([[11, -7, 5], [7.8, -4.6, 2]]);
    expect(drawings.map(drawing => drawing.text)).toEqual([labels.origin, labels.x, labels.y]);
    const x = drawings[1].result.segment, y = drawings[2].result.segment;
    if (x === null || y === null) throw new Error('Missing axes');
    const u = x[1].map((value, i) => (value - x[0][i]) / 5);
    const v = y[1].map((value, i) => (value - y[0][i]) / 5);
    const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9);
    u.forEach((value, i) => near(value, [.6, .8, 0][i]));
    v.forEach((value, i) => near(value, [-.64, .48, -.6][i]));
    near(Math.hypot(...u), 1); near(Math.hypot(...v), 1);
    near(u.reduce((sum, value, i) => sum + value * v[i], 0), 0);
    const origin = x[0];
    [8, -11, 5].forEach((expected, i) => near(origin[i] - 5 * u[i], expected));
    [14.2, -9.4, 8].forEach((expected, i) => near(origin[i] - 5 * v[i], expected));
    [17.16, -4.12, 7.4].forEach((expected, i) => near(origin[i] + 6 * u[i] - 4 * v[i], expected));
    // 面の中心は(100,200,300)。native原点を中心へ移さない。
    expect(origin).not.toEqual(face().centroid);
    expect(drawings[1].result.value).toBe(5);
  });

  it('uses the same live receipt as the cylinder guide without publishing a measurement', () => {
    const state = fixture(), before = state.measurement, guide = planarBasisGuide(state, labels);
    expect(guide?.admission.accounting).toBe(state.meshJsAccounting);
    expect(guide?.drawing.result.segment?.[0]).toEqual([11, -7, 5]);
    expect(state.measurement).toBe(before);
    if (guide === null) throw new Error('Missing guide');
    expect(isPlanarBasisGuideCurrent(guide, state)).toBe(true);
  });

  it.each(['missing', 'nonfinite', 'zero axis', 'wrong handedness', 'nonplane', 'zero area', 'infinite area'])(
    'refuses invalid native basis or display scale: %s', scenario => {
      const current = face(), basis = current.planarBasis;
      if (basis === undefined) throw new Error('Missing native fixture');
      let invalid = current;
      if (scenario === 'missing') invalid = { ...current, planarBasis: undefined };
      if (scenario === 'nonfinite') invalid = { ...current, planarBasis: { ...basis, origin: [Infinity, 0, 0] } };
      if (scenario === 'zero axis') invalid = { ...current, planarBasis: { ...basis, xAxis: [0, 0, 0] } };
      if (scenario === 'wrong handedness') invalid = { ...current, planarBasis: { ...basis, yAxis: [.64, -.48, .6] } };
      if (scenario === 'nonplane') invalid = { ...current, surfaceKind: 'cylinder' };
      if (scenario === 'zero area') invalid = { ...current, area: 0 };
      if (scenario === 'infinite area') invalid = { ...current, area: Infinity };
      expect(planarBasisDrawings(invalid, labels)).toBeNull();
    });

  it.each(['unknown face', 'edge', 'invalid body', 'nonplane', 'duplicate face', 'duplicate body'])(
    'does not reinterpret an unavailable selection: %s', scenario => {
      const state = fixture(), body = state.bodies[0];
      let next = state;
      if (scenario === 'unknown face') next = { ...state, selection: ['plane#face:999'] };
      if (scenario === 'edge') next = { ...state, selection: ['plane#edge:0'] };
      // 形状属性だけを壊し、他の所有票条件は元のままにして独立に拒否する。
      if (scenario === 'invalid body') Object.defineProperty(body, 'isValid', { value: false });
      if (scenario === 'nonplane') Object.defineProperty(body, 'faces', { value: [{ ...face(), surfaceKind: 'cylinder' }] });
      if (scenario === 'duplicate face') Object.defineProperty(body, 'faces', { value: [face(), face()] });
      if (scenario === 'duplicate body') next = { ...state, bodies: [body, body] };
      expect(planarBasisGuide(next, labels)).toBeNull();
    });
  it.each(['missing receipt', 'wrong generation', 'invalid budget', 'missing final', 'wrong outcome',
    'cancelled', 'computing', 'stale math', 'no math', 'multiple', 'no selection', 'timeline', 'other session',
    'different bodies', 'world without receipt'])(
    'refuses %s independently of unchanged shape bytes', scenario => {
      const state = fixture(), guide = planarBasisGuide(state, labels), accounting = state.meshJsAccounting;
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
      if (scenario === 'multiple') next = { ...state, selection: ['plane#face:0', 'plane#face:1'] };
      if (scenario === 'no selection') next = { ...state, selection: [] };
      if (scenario === 'timeline') next = { ...state, timelineIndex: 0 };
      if (scenario === 'other session') next = { ...state, activeDocumentId: 'other' };
      if (scenario === 'different bodies') next = { ...state, bodies: [...state.bodies] };
      if (scenario === 'world without receipt') {
        const bodies = state.bodies.map(body => ({ ...body, coordinateFrame: undefined }));
        next = { ...state, bodies, meshJsAccounting: null };
      }
      expect(planarBasisGuide(next, labels)).toBeNull();
      expect(isPlanarBasisGuideCurrent(guide, next)).toBe(false);
      expect(Array.from(state.bodies[0].mesh.positions)).toEqual(before);
    });

  it('rejects a changed captured layout and a valid but different selection before drawing', () => {
    const state = fixture(), guide = planarBasisGuide(state, labels);
    if (guide === null) throw new Error('Missing guide');
    expect(isPlanarBasisGuideCurrent(guide, { ...state, selection: [...state.selection] })).toBe(false);
    Object.defineProperty(state.bodies[0].mesh, 'positions', { value: new Float32Array(state.bodies[0].mesh.positions) });
    expect(isPlanarBasisGuideCurrent(guide, state)).toBe(false);
    expect(planarBasisGuide(state, labels)).toBeNull();
  });

  it('rejects an otherwise admitted staged preview from a different generation', () => {
    const state = fixture(), guide = planarBasisGuide(state, labels), accounting = state.meshJsAccounting;
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
    expect(planarBasisGuide(next, labels)).toBeNull();
    expect(isPlanarBasisGuideCurrent(guide, next)).toBe(false);
  });

  it('selection and guide recomputation keep document, history and shape bytes unchanged', () => {
    const state = fixture(); useAppStore.setState(state);
    const document = state.document, undo = state.undoStack, redo = state.undoStack.future;
    const bytes = Array.from(state.bodies[0].mesh.positions);
    const pastCount = state.undoStack.past.length, futureCount = state.undoStack.future.length;
    useAppStore.getState().setSelection([]);
    expect(planarBasisGuide(useAppStore.getState(), labels)).toBeNull();
    useAppStore.getState().setSelection(['plane#face:0']);
    expect(planarBasisGuide(useAppStore.getState(), labels)).not.toBeNull();
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().undoStack).toBe(undo); expect(useAppStore.getState().undoStack.future).toBe(redo);
    expect(useAppStore.getState().undoStack.past).toHaveLength(pastCount);
    expect(useAppStore.getState().undoStack.future).toHaveLength(futureCount);
    expect(Array.from(useAppStore.getState().bodies[0].mesh.positions)).toEqual(bytes);
  });

});
