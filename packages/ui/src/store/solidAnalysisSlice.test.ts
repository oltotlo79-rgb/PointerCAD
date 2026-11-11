import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore.js';
import { resetTestStore } from './testing/createTestStore.js';
import { createSolidAnalysisSession, solidSavedInput } from '../solidAnalysis/solidAnalysisSession.js';
import { createSolidSupport } from '../solidAnalysis/solidBoundaryDraft.js';

beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); });
afterEach(() => { useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore(); });
describe('solid analysis store and expression input', () => {
  it('requires the existing strength panel, cancels edits, and keeps focus view-only', () => {
    useAppStore.getState().openSolidAnalysis(); expect(useAppStore.getState().solidAnalysisSession).toBeNull();
    useAppStore.getState().toggleStrength();
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    const initial = useAppStore.getState().solidAnalysisSession;
    if (!initial) throw new Error('Missing solid session');
    runner.cancel.mockClear();
    useAppStore.getState().focusSolidAnalysis('young'); expect(runner.cancel).not.toHaveBeenCalled();
    useAppStore.getState().editSolidAnalysis('young', '210 GPa');
    expect(useAppStore.getState().solidAnalysisSession?.revision).toBe(initial.revision + 1);
    expect(runner.cancel).toHaveBeenCalledOnce();
    useAppStore.getState().closeSolidAnalysis(); expect(useAppStore.getState().solidAnalysisSession).toBeNull();
  });
  it('evaluates expressions and stress units, rejects empty/invalid values and restores no result', () => {
    const base = createSolidAnalysisSession('owner');
    expect(() => solidSavedInput(base, 'part', [])).toThrow();
    const session = { ...base, bodyFeatureId: 'box', fixedFaces: ['bottom'], loadedFaces: ['top'],
      values: { ...base.values, young: '210 GPa', poisson: '0.3', tz: '-4/2', volume: '2*3' } };
    const saved = solidSavedInput(session, 'part', []);
    expect(saved.youngMPa).toBe(210000); expect(saved.tractionMPa).toEqual([0, 0, -2]);
    expect(saved.maximumVolumeDeviationMm3).toBe(6);
    expect(() => solidSavedInput({ ...session, values: { ...session.values, poisson: '0.5' } }, 'part', [])).toThrow();
    const restored = createSolidAnalysisSession('new-owner', saved);
    expect(restored.ownerId).toBe('new-owner'); expect(restored.result).toBeNull(); expect(restored.status).toBe('editing');
    expect(solidSavedInput(restored, 'part', [])).toEqual(saved);
  });
  it('switches the single load mode like an edit and evaluates only the visible load', () => {
    useAppStore.getState().toggleStrength();
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    const initial = useAppStore.getState().solidAnalysisSession;
    if (!initial) throw new Error('Missing solid session');
    expect(initial.loadMode).toBe('traction');
    runner.cancel.mockClear();
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    const switched = useAppStore.getState().solidAnalysisSession;
    expect(switched).toMatchObject({ loadMode: 'pressure', revision: initial.revision + 1, result: null, status: 'editing' });
    expect(runner.cancel).toHaveBeenCalledOnce();
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    expect(useAppStore.getState().solidAnalysisSession).toBe(switched);
    const base = { ...initial, bodyFeatureId: 'box', fixedFaces: ['bottom'], loadedFaces: ['top'] };
    const values = { ...base.values, young: '210 GPa', poisson: '0.3', volume: '1' };
    // Hidden traction drafts (even malformed) do not block or leak into a pressure input, and vice versa.
    const pressure = solidSavedInput({ ...base, loadMode: 'pressure', values: { ...values, tz: 'bad', pressure: '-1.5 MPa' } }, 'part', []);
    expect(pressure).toMatchObject({ schema: 'pointercad-solid-cad-input/2', load: 'pressure', pressureMPa: -1.5 });
    expect('tractionMPa' in pressure).toBe(false);
    expect(solidSavedInput({ ...base, loadMode: 'pressure', values: { ...values, pressure: '0' } }, 'part', []).pressureMPa).toBe(0);
    expect(solidSavedInput({ ...base, loadMode: 'pressure', values: { ...values, pressure: '2 kPa' } }, 'part', []).pressureMPa)
      .toBeCloseTo(0.002, 15);
    const traction = solidSavedInput({ ...base, loadMode: 'traction', values: { ...values, tz: '-2', pressure: 'bad' } }, 'part', []);
    expect(traction).toMatchObject({ schema: 'pointercad-solid-cad-input/1', tractionMPa: [0, 0, -2] });
    expect('pressureMPa' in traction).toBe(false);
    for (const source of ['', 'bad', '1/0']) expect(() => solidSavedInput({ ...base, loadMode: 'pressure',
      values: { ...values, pressure: source } }, 'part', [])).toThrow();
    const restored = createSolidAnalysisSession('owner', pressure);
    expect(restored).toMatchObject({ loadMode: 'pressure', values: { pressure: '-1.5' } });
    expect(solidSavedInput(restored, 'part', [])).toEqual(pressure);
  });
  it('refuses to save an invalid pressure without touching the document or history', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() } });
    useAppStore.getState().openSolidAnalysis();
    useAppStore.getState().setSolidAnalysisLoadMode('pressure');
    useAppStore.getState().editSolidAnalysis('pressure', 'Infinity');
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidAnalysis();
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().solidAnalysisSession?.error).not.toBeNull();
  });
  it('atomically invalidates all three requests and clears old material when the draft is invalid', () => {
    useAppStore.getState().toggleStrength();
    const runner = { run: vi.fn(), cancel: vi.fn(), cancelModal: vi.fn(), cancelBuckling: vi.fn(),
      captureFaces: vi.fn(), validate: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner }); useAppStore.getState().openSolidAnalysis();
    const capacity = { materialConditionId: 'ss400-plate-0-16', yieldMPa: 245, sourceId: 'jisf-g3101-draft', thicknessMm: 16,
      condition: '圧延鋼板（熱処理の指定なし）', evidence: 'standard-draft', basis: 'minimum' } as const;
    useAppStore.getState().setSolidAnalysisMaterial(capacity, true);
    const session = useAppStore.getState().solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    const beforeDoc = useAppStore.getState().document, beforeHistory = useAppStore.getState().undoStack;
    const modal = useAppStore.getState().startSolidModal(), buckling = useAppStore.getState().startSolidBuckling();
    runner.cancel.mockClear(); runner.cancelModal.mockClear(); runner.cancelBuckling.mockClear();
    useAppStore.getState().setSolidAnalysisMaterial(null, false);
    const next = useAppStore.getState().solidAnalysisSession;
    expect(next).toMatchObject({ revision: session.revision + 1, materialInputValid: false, result: null, status: 'editing' });
    expect(next?.capacity).toBeUndefined();
    expect(next?.materialSelectionKey).toBe(session.materialSelectionKey);
    expect(runner.cancel).toHaveBeenCalledOnce(); expect(runner.cancelModal).toHaveBeenCalledOnce(); expect(runner.cancelBuckling).toHaveBeenCalledOnce();
    useAppStore.getState().receiveSolidModal(modal, { kind: 'failed', message: 'old' });
    useAppStore.getState().receiveSolidBuckling(buckling, { kind: 'failed', code: null, message: 'old' });
    expect(useAppStore.getState().solidModal.status).toBe('idle'); expect(useAppStore.getState().solidBuckling.status).toBe('idle');
    useAppStore.getState().saveSolidAnalysis();
    expect(useAppStore.getState().document).toBe(beforeDoc); expect(useAppStore.getState().undoStack).toBe(beforeHistory);
    if (!next) throw new Error('Missing invalid session');
    expect(() => solidSavedInput(next, beforeDoc.id, beforeDoc.parameters)).toThrow();
    useAppStore.getState().setSolidAnalysisMaterial(null, true);
    expect(useAppStore.getState().solidAnalysisSession).toMatchObject({ materialInputValid: true });
    useAppStore.getState().closeSolidAnalysis(); useAppStore.getState().openSolidAnalysis();
    expect(useAppStore.getState().solidAnalysisSession?.materialSelectionKey).not.toBe(session.materialSelectionKey);
    expect(useAppStore.getState().solidAnalysisSession?.materialInputValid).toBeUndefined();
  });
});

describe('solid boundary physical edits and cancellation', () => {
  const edits: readonly (readonly [string, (state: ReturnType<typeof useAppStore.getState>) => void])[] = [
    ['support direction', state => state.editSolidSupport('left', 'x', { fixed: false })],
    ['support displacement', state => state.editSolidSupport('left', 'x', { displacement: '2mm' })],
    ['support removal', state => state.removeSolidSupport('left')],
    ['clamp conversion', state => state.convertSolidFixedFace('bottom')],
    ['clamp removal', state => state.removeSolidFixedFace('bottom')],
    ['gravity enabling', state => state.setSolidGravityEnabled(true)],
    ['gravity acceleration', state => state.editSolidGravity('z', '-2')],
    ['gravity density', state => state.editSolidGravity('density', '7800')],
    ['surface face removal', state => state.clearSolidLoadedFaces()],
  ];
  it.each(edits)('makes %s one revision and cancels all three analyses without writing the document', (_name, edit) => {
    useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
    const state = useAppStore.getState(), session = state.solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn(), cancelModal: vi.fn(), cancelBuckling: vi.fn() };
    useAppStore.setState({ solidAnalysisRunner: runner, solidAnalysisSession: { ...session, bodyFeatureId: 'box',
      fixedFaces: ['bottom'], loadedFaces: ['top'], supports: [{ ...createSolidSupport('left'), prescribed: true, displacement: ['1', '0', '0'] }],
      status: 'running' } });
    state.startSolidModal(); state.startSolidBuckling();
    const before = useAppStore.getState();
    edit(before);
    const after = useAppStore.getState();
    expect(after.solidAnalysisSession?.revision).toBe(session.revision + 1);
    expect(after.solidAnalysisSession).toMatchObject({ status: 'editing', result: null });
    expect(after.solidModal).toMatchObject({ status: 'idle', display: null });
    expect(after.solidBuckling).toMatchObject({ status: 'idle', display: null });
    expect(runner.cancel).toHaveBeenCalledOnce(); expect(runner.cancelModal).toHaveBeenCalledOnce(); expect(runner.cancelBuckling).toHaveBeenCalledOnce();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
  });
  it('zeros a released direction, refuses editing its hidden value, and converts clamps without duplicates', () => {
    useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
    const state = useAppStore.getState(), session = state.solidAnalysisSession;
    if (!session) throw new Error('Missing session');
    useAppStore.setState({ solidAnalysisSession: { ...session, fixedFaces: ['bottom'] } });
    state.convertSolidFixedFace('bottom'); state.convertSolidFixedFace('bottom');
    expect(useAppStore.getState().solidAnalysisSession?.supports).toHaveLength(1);
    expect(useAppStore.getState().solidAnalysisSession?.fixedFaces).toEqual([]);
    state.editSolidSupport('bottom', 'x', { displacement: '2' }); state.editSolidSupport('bottom', 'x', { fixed: false });
    const released = useAppStore.getState().solidAnalysisSession;
    state.editSolidSupport('bottom', 'x', { displacement: '99' });
    expect(useAppStore.getState().solidAnalysisSession).toBe(released);
    expect(released?.supports?.[0]).toMatchObject({ fixed: [false, true, true], displacement: ['0', '0', '0'] });
  });
  it('initializes only empty active load drafts for gravity alone and retains authored surface values', () => {
    useAppStore.getState().toggleStrength(); useAppStore.getState().openSolidAnalysis();
    useAppStore.getState().editSolidAnalysis('tx', '3/2');
    useAppStore.getState().setSolidGravityEnabled(true);
    expect(useAppStore.getState().solidAnalysisSession?.values).toMatchObject({ tx: '3/2', ty: '0', tz: '0', pressure: '' });
    useAppStore.getState().editSolidGravity('density', '7800');
    useAppStore.getState().setSolidGravityEnabled(false);
    expect(useAppStore.getState().solidAnalysisSession?.gravity).toMatchObject({ enabled: false, density: '7800' });
  });
});
