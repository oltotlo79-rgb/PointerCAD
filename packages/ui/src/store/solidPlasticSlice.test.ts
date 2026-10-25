import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORE_SLICE_CREATORS, useAppStore } from './useAppStore.js';
import { resetTestStore } from './testing/createTestStore.js';
import { createSolidPlasticSession, parseLoadHistory, solidPlasticSavedInput,
  type SolidPlasticSession } from '../solidPlastic/solidPlasticSession.js';

/** PROVISIONAL (authored, unexecuted). Benchmark constants for this test only, not a material specification. */
function filled(base: SolidPlasticSession): SolidPlasticSession {
  return { ...base, bodyFeatureId: 'box', fixedFaces: ['bottom'], loadedFaces: ['top'],
    values: { ...base.values, young: '200 GPa', poisson: '0.3', yield: '250', hardening: '2000', tz: '-4/2', volume: '1',
      history: '0, 1, 0, -1, 0', steps: '4', reference: 'Test benchmark constants, not a material specification' } };
}
const runner = () => ({ run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() });

beforeEach(() => { resetTestStore(); useAppStore.setState({ solidPlasticSession: null, solidPlasticRunner: null }); });
afterEach(() => { useAppStore.setState({ solidPlasticSession: null, solidPlasticRunner: null }); resetTestStore(); });

describe('solid plasticity session input (authored, unexecuted)', () => {
  it('evaluates units and the load history, and refuses missing material data without defaults', () => {
    const base = createSolidPlasticSession('owner');
    expect(base.values.young).toBe('');
    expect(base.values.reference).toBe('');
    expect(() => solidPlasticSavedInput(base, 'part', [])).toThrow();
    const saved = solidPlasticSavedInput(filled(base), 'part', []);
    expect(saved.youngMPa).toBe(200000);
    expect(saved.tractionMPa).toEqual([0, 0, -2]);
    expect(saved.loadFactor).toEqual([0, 1, 0, -1, 0]);
    expect(saved.stepsPerSegment).toBe(4);
    const restored = createSolidPlasticSession('new-owner', saved);
    expect(restored.result).toBeNull();
    expect(restored.status).toBe('editing');
    expect(solidPlasticSavedInput(restored, 'part', [])).toEqual(saved);
  });

  it.each([
    ['empty source', { reference: '   ' }],
    ['history not from 0', { history: '1, 0' }],
    ['non-numeric history', { history: '0, 1, x' }],
    ['expression in history', { history: '0, 1+1' }],
    ['fractional steps', { steps: '1.5' }],
    ['yield above E', { yield: '300 GPa' }],
    ['softening', { hardening: '-1' }],
  ])('refuses %s', (_label, patch) => {
    const session = filled(createSolidPlasticSession('owner'));
    expect(() => solidPlasticSavedInput({ ...session, values: { ...session.values, ...patch } }, 'part', [])).toThrow();
  });

  it('parses only plain decimal factors', () => {
    expect(parseLoadHistory(' 0, 1.5 ,-2e-1, .5')).toEqual([0, 1.5, -0.2, 0.5]);
    expect(() => parseLoadHistory('0,,1')).toThrow();
    expect(() => parseLoadHistory('0, Infinity')).toThrow();
  });
});

describe('solid plasticity store (authored, unexecuted)', () => {
  // Regression: the slice was registered in STORE_SLICE_CREATORS but not spread into create<AppState>().
  it('is spread into the real store with a closed initial session and callable actions', () => {
    const initial = useAppStore.getInitialState();
    expect(initial.solidPlasticSession).toBeNull();
    expect(initial.solidPlasticRunner).toBeNull();
    for (const action of ['openSolidPlastic', 'editSolidPlastic', 'focusSolidPlastic', 'saveSolidPlastic',
      'cancelSolidPlastic', 'closeSolidPlastic'] as const) {
      expect(typeof initial[action]).toBe('function');
      expect(typeof useAppStore.getState()[action]).toBe('function');
    }
    // Every registered slice must reach the store, so a missing initializer spread fails here for any slice.
    const state = new Map<string, unknown>(Object.entries(useAppStore.getInitialState()));
    for (const [name, create] of Object.entries(STORE_SLICE_CREATORS)) {
      const slice = new Map<string, unknown>(Object.entries(create(useAppStore.setState, useAppStore.getState, useAppStore)));
      expect(slice.size, name).toBeGreaterThan(0);
      for (const [key, value] of slice) {
        expect(state.has(key), `${name}.${key}`).toBe(true);
        expect(typeof state.get(key), `${name}.${key}`).toBe(typeof value);
      }
    }
    useAppStore.getState().openSolidPlastic();
    expect(useAppStore.getState().solidPlasticSession).toBeNull();
  });

  it('requires the strength panel, and every edit cancels the run and clears an old result', () => {
    useAppStore.getState().openSolidPlastic();
    expect(useAppStore.getState().solidPlasticSession).toBeNull();
    useAppStore.getState().toggleStrength();
    const mock = runner();
    useAppStore.setState({ solidPlasticRunner: mock });
    useAppStore.getState().openSolidPlastic();
    const initial = useAppStore.getState().solidPlasticSession;
    if (!initial) throw new Error('Missing solid plasticity session');
    // A failed earlier run leaves a status and message; an edit must reset both (results are cleared the same way).
    useAppStore.setState({ solidPlasticSession: { ...initial, status: 'failed', error: 'old failure' } });
    mock.cancel.mockClear();
    useAppStore.getState().focusSolidPlastic('young');
    expect(mock.cancel).not.toHaveBeenCalled();
    useAppStore.getState().editSolidPlastic('history', '0, 2, 0');
    const edited = useAppStore.getState().solidPlasticSession;
    expect(mock.cancel).toHaveBeenCalledOnce();
    expect(edited?.revision).toBe(initial.revision + 1);
    expect(edited?.result).toBeNull();
    expect(edited?.error).toBeNull();
    expect(edited?.status).toBe('editing');
  });

  it('cancel keeps no result and reports the cancelled state', () => {
    useAppStore.getState().toggleStrength();
    const mock = runner();
    useAppStore.setState({ solidPlasticRunner: mock });
    useAppStore.getState().openSolidPlastic();
    useAppStore.getState().cancelSolidPlastic();
    expect(mock.cancel).toHaveBeenCalled();
    expect(useAppStore.getState().solidPlasticSession?.status).toBe('cancelled');
    expect(useAppStore.getState().solidPlasticSession?.result).toBeNull();
  });

  it('saves through the document contract so Undo/Redo and reopen restore exactly the saved input', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidPlasticRunner: runner() });
    useAppStore.getState().openSolidPlastic();
    const session = useAppStore.getState().solidPlasticSession;
    if (!session) throw new Error('Missing solid plasticity session');
    useAppStore.setState({ solidPlasticSession: filled(session) });
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidPlastic();
    const after = useAppStore.getState().document;
    expect(useAppStore.getState().solidPlasticSession?.error).toBeNull();
    const saved = after.beamAnalysisInputs?.analyses.find(value => value.kind === 'solid-plastic-cad');
    expect(saved?.kind).toBe('solid-plastic-cad');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(before.beamAnalysisInputs);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document.beamAnalysisInputs).toEqual(after.beamAnalysisInputs);
    useAppStore.getState().closeSolidPlastic();
    useAppStore.getState().openSolidPlastic();
    const reopened = useAppStore.getState().solidPlasticSession;
    if (!reopened || saved?.kind !== 'solid-plastic-cad') throw new Error('Missing reopened session');
    expect(solidPlasticSavedInput(reopened, after.id, after.parameters)).toEqual(saved.definition);
  });

  it('does not save and shows an error when the input is invalid', () => {
    useAppStore.getState().toggleStrength();
    useAppStore.setState({ solidPlasticRunner: runner() });
    useAppStore.getState().openSolidPlastic();
    const before = useAppStore.getState().document;
    useAppStore.getState().saveSolidPlastic();
    expect(useAppStore.getState().document).toBe(before);
    expect(useAppStore.getState().solidPlasticSession?.error).not.toBeNull();
  });
});
