import { readBeamAnalysisInputs, withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatigueLocalCyclePanel } from './FatigueLocalCyclePanel.js';
import { attachFatigueLocalCycle } from './attachFatigueLocalCycle.js';
import { FATIGUE_LOCAL_CYCLE_NUMBER_FIELDS, createFatigueLocalCycleSession, currentFatigueLocalCycleResult,
  editFatigueLocalCycleSession, fatigueLocalCycleDraftIsSaved, fatigueLocalCycleSaved, restoreFatigueLocalCycleSession,
  runFatigueLocalCycleSession, savedFatigueLocalCycleInput, type FatigueLocalCycleEdit,
  type FatigueLocalCycleSession } from './fatigueLocalCycleSession.js';

/* Regressions completing task007: the panel's per-field refusal marks, the correction choice without an implicit value,
 * result invalidation by every physical edit and by a real owner change or reopen, and the actual part store
 * save -> Undo/Redo -> cold reopen beside the inputs a document already holds. Manufactured test-only coefficients
 * (not a real material): b = c = -0.5, E = 200000 MPa, sigma_f' = 1000 MPa, eps_f' = 0.995, so for SWT
 * sigma_max eps_a = 1000 / (2N); the cycle 500/-300 MPa with eps_a = 0.01 gives 2N = 200, N = 100 (hand-derived). */
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

const text = (field: Extract<FatigueLocalCycleEdit, { kind: 'text' }>['field'], value: string): FatigueLocalCycleEdit =>
  ({ kind: 'text', field, value });
const VALID: readonly FatigueLocalCycleEdit[] = [
  { kind: 'correction', value: 'swt' }, { kind: 'derivation', value: 'measured' },
  text('materialId', 'manufactured'), text('elasticModulusMpa', '200000'), text('fatigueStrengthCoefficientMpa', '1000'),
  text('fatigueStrengthExponent', '-0.5'), text('fatigueDuctilityCoefficient', '0.995'), text('fatigueDuctilityExponent', '-0.5'),
  text('minimumCycles', '1'), text('maximumCycles', '1000000'),
  text('materialReference', 'Test-only manufactured coefficients; not a material value'), text('materialCondition', 'Hand-derived example'),
  text('strainMax', '0.01'), text('strainMin', '-0.01'), text('stressMax', '500'), text('stressMin', '-300'),
  text('cycleReference', 'Test-only local cycle'), text('cycleCondition', 'Hand-derived example'),
];
const edited = (edits: readonly FatigueLocalCycleEdit[], owner = 'owner'): FatigueLocalCycleSession =>
  edits.reduce(editFatigueLocalCycleSession, createFatigueLocalCycleSession(owner));
const near = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(1e-9 * expected);
};
function store(): FatigueLocalCycleSession {
  const value = useAppStore.getState().fatigueLocalCycleSession;
  if (value === null) throw new Error('No local-cycle session');
  return value;
}
function render(session: FatigueLocalCycleSession): string {
  useAppStore.setState({ fatigueLocalCycleSession: session });
  return renderToStaticMarkup(<FatigueLocalCyclePanel session={session} />);
}
/** aria-invalid of one control, read from the rendered markup (attribute order of React's server renderer). */
function invalid(html: string, field: string): boolean {
  const match = new RegExp(`data-fatigue-local-cycle-field="${field}"[^>]*aria-invalid="(true|false)"`, 'u').exec(html);
  if (match === null) throw new Error(`No control ${field}`);
  return match[1] === 'true';
}
const selected = (html: string): string[] => [...html.matchAll(/<option value="([^"]*)" selected="">/gu)].map(match => match[1] ?? '');

/* Synthetic inputs that a part may already hold (manufactured values, written out here). */
const source = { kind: 'user-supplied', reference: 'synthetic coexistence fixture', condition: 'manufactured values only' };
const material = { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
  fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
  calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source };
const existing = (documentId: string): unknown[] => [
  { kind: 'fatigue', definition: { schema: 'pointercad-fatigue-saved/3', id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [150, 250],
      sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 1001, source } } },
  { kind: 'fatigue-strain-life', definition: { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life',
    source: { documentId }, input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material,
      histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125], sequence: 'repeated-periodic', repeats: 10, source }] } } },
];
/** A part (no assembly) with a strength panel and the existing inputs applied as one user edit. */
function partWithExistingInputs(): void {
  useAppStore.setState({ assembly: null, strengthSession: bucklingUiFixture().state.strengthSession });
  const state = useAppStore.getState();
  state.applyDocument(withBeamAnalysisInputs(state.document, { schema: 'pointercad-beam-inputs/1', analyses: existing(state.document.id) }));
}
function analysesOfPart() {
  return useAppStore.getState().document.beamAnalysisInputs?.analyses ?? [];
}

describe('local-cycle panel refusal marks', () => {
  it('marks only the cycle source for a refused cycle source and only the material source for a refused material source', () => {
    const cycle = render(runFatigueLocalCycleSession(edited([...VALID, text('cycleReference', ' ')]), 'owner'));
    expect(['cycleReference', 'cycleCondition', 'materialReference', 'materialCondition'].map(field => invalid(cycle, field)))
      .toEqual([true, true, false, false]);
    const materialSource = render(runFatigueLocalCycleSession(edited([...VALID, text('materialCondition', ' ')]), 'owner'));
    expect(['cycleReference', 'cycleCondition', 'materialReference', 'materialCondition'].map(field => invalid(materialSource, field)))
      .toEqual([false, false, true, true]);
  });

  it('marks exactly the refused number among material and cycle values', () => {
    const html = render(runFatigueLocalCycleSession(edited([...VALID, text('minimumCycles', '0')]), 'owner'));
    const marked = [...FATIGUE_LOCAL_CYCLE_NUMBER_FIELDS, 'materialId', 'correction', 'derivation']
      .filter(field => invalid(html, field));
    expect(marked).toEqual(['minimumCycles']);
  });
});

describe('local-cycle correction choice', () => {
  it('selects no correction or derivation until the user chooses one and refuses to run or save without it', () => {
    const empty = render(createFatigueLocalCycleSession('owner'));
    expect(selected(empty)).toEqual(['', '']);
    const withoutCorrection = edited(VALID.filter(edit => edit.kind !== 'correction'));
    expect(withoutCorrection.draft.correction).toBe('');
    const run = runFatigueLocalCycleSession(withoutCorrection, 'owner');
    expect([run.analyzed, run.refusal?.key, run.refusal?.path]).toEqual([null, 'fatigueLocalCycle.error.correction', 'correction']);
    expect(invalid(render(run), 'correction')).toBe(true);
    expect(fatigueLocalCycleSaved(withoutCorrection, 'owner').ok).toBe(false);
  });

  it('shows the chosen and the restored method as the selected option, and clearing it drops the result', () => {
    const swt = runFatigueLocalCycleSession(edited(VALID), 'owner');
    expect(selected(render(swt))).toEqual(['swt', 'measured']);
    const checked = fatigueLocalCycleSaved(edited([...VALID, { kind: 'correction', value: 'morrow' }]), 'owner');
    if (!checked.ok) throw new Error(checked.refusal.key);
    expect(selected(render(restoreFatigueLocalCycleSession('owner', checked.saved)))).toEqual(['morrow', 'measured']);
    const cleared = editFatigueLocalCycleSession(swt, { kind: 'correction', value: '' });
    expect([currentFatigueLocalCycleResult(cleared), cleared.refusal]).toEqual([null, null]);
    expect(render(cleared)).not.toContain('data-testid="fatigue-local-cycle-result"');
  });
});

describe('local-cycle result invalidation', () => {
  const changes: readonly FatigueLocalCycleEdit[] = [
    ...FATIGUE_LOCAL_CYCLE_NUMBER_FIELDS.map(field => text(field, '2')),
    text('materialId', 'other'), text('materialReference', 'other'), text('materialCondition', 'other'),
    text('cycleReference', 'other'), text('cycleCondition', 'other'),
    { kind: 'correction', value: 'morrow' }, { kind: 'derivation', value: 'elastic-plastic-analysis' },
  ];
  it.each(changes.map(change => [change.kind === 'text' ? change.field : change.kind, change] as const))(
    'a store edit of %s drops the shown result', (_label, change) => {
      useAppStore.setState({ strengthSession: bucklingUiFixture().state.strengthSession, assembly: null });
      useAppStore.getState().openFatigueLocalCycle();
      for (const edit of VALID) useAppStore.getState().editFatigueLocalCycle(edit);
      useAppStore.getState().runFatigueLocalCycle();
      near(currentFatigueLocalCycleResult(store())?.cyclesToFailure, 100);
      useAppStore.getState().editFatigueLocalCycle(change);
      expect([store().analyzed, currentFatigueLocalCycleResult(store())]).toEqual([null, null]);
      expect(render(store())).not.toContain('data-testid="fatigue-local-cycle-result"');
    });

  it('never runs or saves the previous owner\'s session after a real reopen, and the lifecycle closes it', () => {
    const fixture = bucklingUiFixture();
    const assembly = fixture.state.assembly;
    if (assembly === null) throw new Error('Fixture without assembly');
    useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
    useAppStore.setState({ strengthSession: fixture.state.strengthSession });
    useAppStore.getState().openFatigueLocalCycle();
    for (const edit of VALID) useAppStore.getState().editFatigueLocalCycle(edit);
    useAppStore.getState().runFatigueLocalCycle();
    const owner = useAppStore.getState().activeDocumentId;
    expect([store().ownerId, currentFatigueLocalCycleResult(store()) === null]).toEqual([owner, false]);
    // The same assembly opened again is a new document session (a new owner), with the strength panel shown again.
    useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
    useAppStore.setState({ strengthSession: fixture.state.strengthSession });
    expect(useAppStore.getState().activeDocumentId).not.toBe(owner);
    // Without the lifecycle attached the previous session is still in the store: run and save must not touch it or the
    // reopened document.
    const stale = store(), reopened = useAppStore.getState().assembly;
    expect(stale.ownerId).toBe(owner);
    useAppStore.getState().runFatigueLocalCycle();
    useAppStore.getState().saveFatigueLocalCycle();
    expect(useAppStore.getState().fatigueLocalCycleSession).toBe(stale);
    expect(useAppStore.getState().assembly).toBe(reopened);
    expect(savedFatigueLocalCycleInput(reopened ?? assembly)).toBeNull();
    const detach = attachFatigueLocalCycle();
    try {
      // Any store change applies the lifecycle; the strength panel is open, so only the owner check closes it.
      useAppStore.setState({ fatigueLocalCycleSession: stale });
      expect(useAppStore.getState().fatigueLocalCycleSession).toBeNull();
      // Opening for the new owner starts from the (unsaved, so empty) document input, without any result.
      useAppStore.getState().openFatigueLocalCycle();
      expect([store().ownerId, store().analyzed, store().draft.correction, store().draft.stressMax])
        .toEqual([useAppStore.getState().activeDocumentId, null, '', '']);
    } finally {
      detach();
    }
  });
});

describe('local-cycle input in a part through the store', () => {
  it('saves beside existing inputs, follows Undo/Redo and returns after a cold reopen without a result', () => {
    partWithExistingInputs();
    const others = analysesOfPart();
    expect(others.map(input => input.kind)).toEqual(['fatigue', 'fatigue-strain-life']);
    const detach = attachFatigueLocalCycle();
    try {
      useAppStore.getState().openFatigueLocalCycle();
      for (const edit of VALID) useAppStore.getState().editFatigueLocalCycle(edit);
      useAppStore.getState().runFatigueLocalCycle();
      useAppStore.getState().saveFatigueLocalCycle();
      const saved = useAppStore.getState().document;
      expect(analysesOfPart().filter(input => input.kind !== 'fatigue-local-cycle')).toEqual(others);
      expect(savedFatigueLocalCycleInput(saved)?.input.cycle.stressMax).toBe(500);
      expect(store().refusal).toBeNull();
      expect(render(store())).toContain('data-testid="fatigue-local-cycle-saved"');

      // Undo removes only the local cycle (the existing inputs stay); Redo brings back the same saved input.
      useAppStore.getState().undo();
      expect([savedFatigueLocalCycleInput(useAppStore.getState().document), analysesOfPart()]).toEqual([null, others]);
      expect(fatigueLocalCycleDraftIsSaved(store(), useAppStore.getState().document.id,
        savedFatigueLocalCycleInput(useAppStore.getState().document))).toBe(false);
      expect(render(store())).not.toContain('data-testid="fatigue-local-cycle-saved"');
      useAppStore.getState().redo();
      expect(savedFatigueLocalCycleInput(useAppStore.getState().document)).toEqual(savedFatigueLocalCycleInput(saved));

      // Cold reopen: the attachment goes through JSON and the reader, and the part opens as a new document session.
      const owner = useAppStore.getState().activeDocumentId;
      const reread = readBeamAnalysisInputs(JSON.parse(JSON.stringify(saved.beamAnalysisInputs)), saved.id);
      if (!reread.ok) throw new Error(reread.issue.message);
      useAppStore.getState().resetDocument({ ...saved, beamAnalysisInputs: reread.value });
      expect(useAppStore.getState().activeDocumentId).not.toBe(owner);
      expect(useAppStore.getState().fatigueLocalCycleSession).toBeNull();
      useAppStore.setState({ strengthSession: bucklingUiFixture().state.strengthSession });
      useAppStore.getState().openFatigueLocalCycle();
      expect([store().ownerId, store().analyzed, store().refusal]).toEqual([useAppStore.getState().activeDocumentId, null, null]);
      expect([store().draft.correction, store().draft.derivation, store().draft.stressMax, store().draft.cycleReference])
        .toEqual(['swt', 'measured', '500', 'Test-only local cycle']);
      const html = render(store());
      expect(html).toContain('data-testid="fatigue-local-cycle-saved"');
      expect(html).not.toContain('data-testid="fatigue-local-cycle-result"');
      expect(analysesOfPart().filter(input => input.kind !== 'fatigue-local-cycle')).toEqual(others);
      // The reopened history starts here: Undo does not return to the document before the reopen.
      expect(useAppStore.getState().canUndo).toBe(false);
      useAppStore.getState().runFatigueLocalCycle();
      near(currentFatigueLocalCycleResult(store())?.cyclesToFailure, 100);
    } finally {
      detach();
    }
  });
});
