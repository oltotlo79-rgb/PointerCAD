import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore.js';
import { resetTestStore } from './testing/createTestStore.js';
import { createSolidAnalysisSession, solidSavedInput } from '../solidAnalysis/solidAnalysisSession.js';

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
});
