import { analyzeCadSolidFinite } from '@pointercad/fem';
import { context, finiteSettings, kernel, ownedClient } from '@pointercad/fem/testing/ui-fixtures';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBeamAnalysisInputs, type SolidPlasticCadSavedInput } from '@pointercad/model/beam-analysis';
import { STORE_SLICE_CREATORS, useAppStore } from './useAppStore.js';
import { resetTestStore } from './testing/createTestStore.js';
import { createSolidFiniteSession, solidFiniteSavedInput, type SolidFiniteEdit, type SolidFiniteSession } from '../solidFinite/solidFiniteSession.js';
import { createSolidSupport } from '../solidAnalysis/solidBoundaryDraft.js';

function filled(session: SolidFiniteSession): SolidFiniteSession {
  return { ...session, bodyFeatureId: 'box', fixedFaces: ['bottom'], loadedFaces: ['top'], supports: [createSolidSupport('side')],
    values: { ...session.values, young: '200 GPa', poisson: '0.3', yield: '250', hardening: '2000', tz: '-2', volume: '1',
      forceFactors: '1,0,-1', prescribedFactors: '0,-1,1', reference: 'Synthetic benchmark source' } };
}
const runner = () => ({ run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() });
function open() {
  useAppStore.getState().toggleStrength();
  const mock = runner(); useAppStore.setState({ solidFiniteRunner: mock }); useAppStore.getState().openSolidFinite();
  const session = useAppStore.getState().solidFiniteSession;
  if (!session) throw new Error('Missing finite session');
  useAppStore.setState({ solidFiniteSession: filled(session) });
  mock.cancel.mockClear(); return mock;
}
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidFiniteSession: null, solidFiniteRunner: null }); });
afterEach(() => { useAppStore.getState().closeSolidFinite(); resetTestStore(); });
describe('finite slice registered in the real store', () => {
  it('is registered and initialized, and requires the strength panel', () => {
    const initial = useAppStore.getInitialState();
    expect(initial.solidFiniteSession).toBeNull(); expect(initial.solidFiniteRunner).toBeNull();
    const state = new Map<string, unknown>(Object.entries(initial));
    for (const [name, create] of Object.entries(STORE_SLICE_CREATORS)) {
      for (const [key, value] of Object.entries(create(useAppStore.setState, useAppStore.getState, useAppStore))) {
        expect(state.has(key), `${name}.${key}`).toBe(true); expect(typeof state.get(key), `${name}.${key}`).toBe(typeof value);
      }
    }
    for (const key of ['openSolidFinite', 'closeSolidFinite', 'editSolidFinite', 'focusSolidFinite',
      'focusSolidFiniteBoundary', 'saveSolidFinite', 'cancelSolidFinite'] as const) expect(typeof initial[key]).toBe('function');
    useAppStore.getState().openSolidFinite(); expect(useAppStore.getState().solidFiniteSession).toBeNull();
  });
  const edits: readonly SolidFiniteEdit[] = [
    { kind: 'field', field: 'yield', value: '300' },
    { kind: 'support', face: 'side', axis: 'x', displacement: '-2' },
    { kind: 'support', face: 'side', axis: 'y', fixed: false },
    { kind: 'remove-support', face: 'side' }, { kind: 'convert-clamp', face: 'bottom' },
    { kind: 'remove-clamp', face: 'bottom' }, { kind: 'clear-loaded' },
    { kind: 'gravity-enabled', enabled: true }, { kind: 'gravity', field: 'density', value: '7800' },
    { kind: 'gravity', field: 'z', value: '-10' },
  ];
  it.each(edits)('cancels and invalidates each physical edit $kind without document history', edit => {
    const mock = open(), before = useAppStore.getState(), session = before.solidFiniteSession;
    if (!session) throw new Error('Missing finite session');
    useAppStore.setState({ solidFiniteSession: { ...session, status: 'failed', error: 'old' } });
    useAppStore.getState().editSolidFinite(edit);
    const after = useAppStore.getState();
    expect(mock.cancel).toHaveBeenCalledOnce(); expect(after.solidFiniteSession?.revision).toBe(session.revision + 1);
    expect(after.solidFiniteSession?.result).toBeNull(); expect(after.solidFiniteSession?.error).toBeNull();
    expect(after.solidFiniteSession?.status).toBe('editing'); expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
  });
  it('changes only the display choice without cancelling, revising, saving or changing the result', async () => {
    const mock = open(), before = useAppStore.getState(), original = before.solidFiniteSession;
    if (!original) throw new Error('Missing finite session');
    const base = context(), current = { ...base, documentId: before.document.id, revision: before.completedGeneration };
    const client = ownedClient(), settings = { ...finiteSettings(current), forceFactors: [0, 0], prescribedDisplacementFactors: [0, 0] };
    const outcome = await analyzeCadSolidFinite(client.client, kernel(), () => current, settings);
    if (outcome.kind !== 'result') throw new Error('Synthetic finite fixture failed');
    try {
      useAppStore.setState({ solidFiniteSession: { ...original, bodyFeatureId: current.body.featureId, status: 'complete', result: outcome } });
      const previous = useAppStore.getState(), old = previous.solidFiniteSession;
      if (!old) throw new Error('Missing completed session');
      useAppStore.getState().setSolidFiniteFieldView({ step: 2, quantity: 'xy', deformationScale: 0 });
      const after = useAppStore.getState(), session = after.solidFiniteSession;
      expect(session?.fieldView).toEqual({ step: 2, quantity: 'xy', deformationScale: 0 });
      expect(session?.revision).toBe(old.revision); expect(session?.result).toBe(outcome);
      expect(after.document).toBe(previous.document); expect(after.undoStack).toBe(previous.undoStack);
      expect(mock.cancel).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
      const choice = session?.fieldView;
      useAppStore.getState().setSolidFiniteFieldView({ step: 3 });
      useAppStore.getState().setSolidFiniteFieldView({ step: 0 });
      useAppStore.getState().setSolidFiniteFieldView({ deformationScale: -1 });
      useAppStore.getState().setSolidFiniteFieldView({ deformationScale: Number.NaN });
      expect(useAppStore.getState().solidFiniteSession?.fieldView).toBe(choice);
      useAppStore.getState().setSolidFiniteFieldView({ deformationScale: 3 });
      expect(useAppStore.getState().solidFiniteSession?.fieldView.deformationScale).toBe(3);
    } finally { client.client.dispose(); }
  });
  it('focus is display-only; freeing an axis clears only that axis and preserves authored displacement state', () => {
    const mock = open(), before = useAppStore.getState();
    useAppStore.getState().focusSolidFinite('young'); useAppStore.getState().focusSolidFiniteBoundary('side-x');
    expect(useAppStore.getState().solidFiniteSession?.focused).toBeNull();
    expect(useAppStore.getState().solidFiniteSession?.boundaryFocused).toBe('side-x');
    expect(useAppStore.getState().solidFiniteSession?.revision).toBe(before.solidFiniteSession?.revision);
    expect(mock.cancel).not.toHaveBeenCalled(); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    useAppStore.getState().editSolidFinite({ kind: 'support', face: 'side', axis: 'x', displacement: '-2' });
    useAppStore.getState().editSolidFinite({ kind: 'support', face: 'side', axis: 'x', fixed: false });
    expect(useAppStore.getState().solidFiniteSession?.supports?.[0]).toMatchObject({ fixed: [false, true, true],
      displacement: ['0', '0', '0'], prescribed: true });
  });
  it('does not edit a foreign owner or turn unknown removals into physical edits', () => {
    const mock = open(), session = useAppStore.getState().solidFiniteSession;
    if (!session) throw new Error('Missing finite session');
    useAppStore.getState().editSolidFinite({ kind: 'remove-support', face: 'missing' });
    expect(mock.cancel).not.toHaveBeenCalled();
    useAppStore.setState({ solidFiniteSession: { ...session, ownerId: 'other' } });
    useAppStore.getState().editSolidFinite({ kind: 'clear-loaded' }); useAppStore.getState().saveSolidFinite();
    expect(mock.cancel).not.toHaveBeenCalled(); expect(mock.validate).not.toHaveBeenCalled();
  });
  it('saves one document history, preserves other modes, and Undo/Redo and reopen retain the definition', () => {
    const mock = open(), initial = useAppStore.getState(), session = initial.solidFiniteSession;
    if (!session) throw new Error('Missing finite session');
    const finite = solidFiniteSavedInput(session, initial.document.id, initial.document.parameters);
    const { forceFactors, prescribedDisplacementFactors, supports, ...common } = finite;
    void forceFactors; void prescribedDisplacementFactors; void supports;
    const plastic: SolidPlasticCadSavedInput = { ...common, schema: 'pointercad-solid-plastic-cad-input/1', id: 'solid-plastic-cad',
      loadFactor: [0, 1, 0], stepsPerSegment: 4 };
    // Install the fixture through the real store so document and undoStack.present agree before saving.
    initial.applyDocument(withBeamAnalysisInputs(initial.document,
      { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'solid-plastic-cad', definition: plastic }] }), { undoable: false });
    const before = useAppStore.getState().document, apply = vi.spyOn(useAppStore.getState(), 'applyDocument');
    useAppStore.getState().saveSolidFinite();
    expect(mock.validate).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledOnce();
    const after = useAppStore.getState().document;
    expect(after.beamAnalysisInputs?.analyses).toEqual([{ kind: 'solid-plastic-cad', definition: plastic },
      { kind: 'solid-finite-cad', definition: finite }]);
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toEqual(before);
    useAppStore.getState().redo(); expect(useAppStore.getState().document).toEqual(after);
    useAppStore.getState().closeSolidFinite(); useAppStore.getState().openSolidFinite();
    expect(useAppStore.getState().solidFiniteSession).toEqual(createSolidFiniteSession(initial.activeDocumentId, finite));
    apply.mockRestore();
  });
  it('keeps invalid save/validation failure/cancel/close out of history and never revives a closed session', () => {
    const mock = open(), before = useAppStore.getState();
    useAppStore.getState().editSolidFinite({ kind: 'field', field: 'forceFactors', value: '' });
    useAppStore.getState().saveSolidFinite(); expect(useAppStore.getState().solidFiniteSession?.error).not.toBeNull();
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    mock.validate.mockImplementation(() => { throw new Error('Invalid current boundary'); });
    useAppStore.getState().saveSolidFinite(); expect(useAppStore.getState().solidFiniteSession?.error).toBe('Invalid current boundary');
    useAppStore.getState().cancelSolidFinite(); expect(useAppStore.getState().solidFiniteSession?.status).toBe('cancelled');
    useAppStore.getState().closeSolidFinite(); expect(useAppStore.getState().solidFiniteSession).toBeNull();
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
  it('does not commit validation that switches the current document or closes the session', () => {
    const mock = open(), before = useAppStore.getState();
    mock.validate.mockImplementation(() => { useAppStore.setState({ document: { ...before.document } }); });
    useAppStore.getState().saveSolidFinite(); expect(useAppStore.getState().document.beamAnalysisInputs).toBeUndefined();
    mock.validate.mockImplementation(() => { useAppStore.getState().closeSolidFinite(); });
    useAppStore.getState().saveSolidFinite(); expect(useAppStore.getState().solidFiniteSession).toBeNull();
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
  });
});
