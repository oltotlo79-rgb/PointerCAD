import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatigueLocalCyclePanel } from './FatigueLocalCyclePanel.js';
import { attachFatigueLocalCycle } from './attachFatigueLocalCycle.js';
import { createFatigueLocalCycleSession, currentFatigueLocalCycleResult, editFatigueLocalCycleSession, fatigueLocalCycleSaved,
  restoreFatigueLocalCycleSession, runFatigueLocalCycleSession, savedFatigueLocalCycleInput, type FatigueLocalCycleEdit,
  type FatigueLocalCycleSession } from './fatigueLocalCycleSession.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/* Manufactured, test-only coefficients typed as a user would (not a real material): b = c = -0.5, E = 200000,
 * sigma_f' = 1000, eps_f' = 0.995. Closed forms independent of the solver:
 *  SWT: sigma_max eps_a = 1000 / (2N); the cycle 500/-300 MPa with eps_a 0.01 gives 5 MPa, 2N = 200, N = 100.
 *  Morrow: 2N = (((1000 - sigma_m)/200000 + 0.995) / eps_a)^2; sigma_m = 100, eps_a = 0.01 gives N = 4995.00125. */
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
function openAssemblyWithStrength(): void {
  const fixture = bucklingUiFixture();
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}

describe('local-cycle draft', () => {
  it('starts with no correction, no derivation and no value, and refuses to run', () => {
    const empty = createFatigueLocalCycleSession('owner');
    expect([empty.draft.correction, empty.draft.derivation, empty.draft.stressMax, empty.draft.elasticModulusMpa]).toEqual(['', '', '', '']);
    const run = runFatigueLocalCycleSession(empty, 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key: 'fatigueLocalCycle.error.correction', code: null, path: 'correction' }]);
  });

  it('runs the actual SWT and Morrow analyses with closed-form lives in cycles', () => {
    const swt = currentFatigueLocalCycleResult(runFatigueLocalCycleSession(edited(VALID), 'owner'));
    near(swt?.cyclesToFailure, 100);
    expect(swt?.reversalsToFailure).toBe(2 * (swt?.cyclesToFailure ?? Number.NaN));
    const morrow = currentFatigueLocalCycleResult(runFatigueLocalCycleSession(edited([...VALID, { kind: 'correction', value: 'morrow' }]), 'owner'));
    near(morrow?.cyclesToFailure, 4995.00125);
    expect(morrow?.swtParameterMpa).toBeNull();
  });

  it('drops the result on any edit and never keeps an earlier result after a refused run', () => {
    const run = runFatigueLocalCycleSession(edited(VALID), 'owner');
    const changed = editFatigueLocalCycleSession(run, text('stressMax', '450'));
    expect([changed.revision, changed.analyzed, currentFatigueLocalCycleResult(changed)]).toEqual([run.revision + 1, null, null]);
    expect(currentFatigueLocalCycleResult({ ...changed, analyzed: run.analyzed })).toBeNull();
  });

  const refusals: [string, readonly FatigueLocalCycleEdit[], string, string | null, string][] = [
    ['SWT non-positive maximum stress', [text('stressMax', '0'), text('stressMin', '-500')], 'fatigueLocalCycle.error.swtNonpositive',
      'swt-nonpositive-maximum-stress', 'cycle.stressMax'],
    ['Morrow mean at sigma_f\'', [{ kind: 'correction', value: 'morrow' }, text('stressMax', '1100'), text('stressMin', '900')],
      'fatigueLocalCycle.error.morrowDomain', 'strain-life-morrow-domain', 'cycle'],
    ['life beyond the calibrated maximum', [text('maximumCycles', '50')], 'fatigueLocalCycle.error.longer',
      'strain-life-longer-than-calibration', 'cycle'],
    ['expression instead of a number', [text('stressMax', '500 MPa')], 'fatigueLocalCycle.error.number', null, 'stressMax'],
    ['unchosen derivation', [{ kind: 'derivation', value: '' }], 'fatigueLocalCycle.error.derivation', null, 'cycle.derivation'],
    ['modulus in GPa (reader)', [text('elasticModulusMpa', '206')], 'fatigueLocalCycle.error.input', 'fatigue-local-cycle',
      'material.elasticModulusMpa'],
    ['reversed extrema (reader)', [text('strainMax', '-0.02')], 'fatigueLocalCycle.error.input', 'fatigue-local-cycle', 'cycle.strainMin'],
    ['blank cycle source (reader)', [text('cycleReference', ' ')], 'fatigueLocalCycle.error.input', 'fatigue-local-cycle', 'cycle.source'],
  ];
  it.each(refusals)('refuses %s with its message, code and path and without a result', (_label, changes, key, code, path) => {
    const run = runFatigueLocalCycleSession(edited([...VALID, ...changes]), 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key, code, path }]);
  });

  it('restores a saved input to a draft that saves the identical input again', () => {
    const checked = fatigueLocalCycleSaved(edited([...VALID, text('fatigueDuctilityCoefficient', '1.2345678901234567e-3')]), 'owner');
    if (!checked.ok) throw new Error(checked.refusal.key);
    const restored = restoreFatigueLocalCycleSession('owner', checked.saved);
    const again = fatigueLocalCycleSaved(restored, 'owner');
    expect(again.ok ? again.saved : null).toEqual(checked.saved);
    expect(restored.analyzed).toBeNull();
  });
});

describe('local-cycle inputs in the document', () => {
  it('saves into the assembly through Undo beside other inputs, never stores a result and restores cold', () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    const others = before.beamAnalysisInputs?.analyses ?? [];
    useAppStore.getState().openFatigueLocalCycle();
    for (const edit of VALID) useAppStore.getState().editFatigueLocalCycle(edit);
    useAppStore.getState().runFatigueLocalCycle();
    near(currentFatigueLocalCycleResult(store())?.cyclesToFailure, 100);
    useAppStore.getState().saveFatigueLocalCycle();
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    expect(assembly.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue-local-cycle')).toEqual(others);
    expect(savedFatigueLocalCycleInput(assembly)?.input.correction).toBe('swt');
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:cyclesToFailure|reversalsToFailure|swtParameterMpa|analyzed|result)"/u);
    expect(currentFatigueLocalCycleResult(store())).not.toBeNull();
    const reread = readBeamAnalysisInputs(JSON.parse(JSON.stringify(assembly.beamAnalysisInputs)), assembly.id);
    expect(reread.ok ? reread.value : null).toEqual(assembly.beamAnalysisInputs);
    // Reopen: the saved draft returns, without any result.
    useAppStore.getState().closeFatigueLocalCycle();
    useAppStore.getState().openFatigueLocalCycle();
    expect([store().analyzed, store().draft.correction, store().draft.stressMax]).toEqual([null, 'swt', '500']);
    // Undo removes only this input; reopening starts empty. Redo brings it back.
    useAppStore.getState().undoAssembly();
    expect(savedFatigueLocalCycleInput(useAppStore.getState().assembly ?? before)).toBeNull();
    useAppStore.getState().closeFatigueLocalCycle();
    useAppStore.getState().openFatigueLocalCycle();
    expect([store().analyzed, store().draft.correction]).toEqual([null, '']);
    useAppStore.getState().redoAssembly();
    expect(savedFatigueLocalCycleInput(useAppStore.getState().assembly ?? before)?.input.cycle.stressMax).toBe(500);
  });

  it('refuses an unsavable draft without editing the document or its Undo history', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    useAppStore.getState().openFatigueLocalCycle();
    const document = useAppStore.getState().document, canUndo = useAppStore.getState().canUndo;
    for (const edit of VALID) useAppStore.getState().editFatigueLocalCycle(edit);
    useAppStore.getState().editFatigueLocalCycle({ kind: 'correction', value: '' });
    useAppStore.getState().saveFatigueLocalCycle();
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().canUndo).toBe(canUndo);
    expect([store().refusal?.key, store().analyzed]).toEqual(['fatigueLocalCycle.error.correction', null]);
  });

  it('closes on owner change and when the strength panel closes, and a foreign session never runs or saves', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    useAppStore.getState().openFatigueLocalCycle();
    for (const edit of VALID) useAppStore.getState().editFatigueLocalCycle(edit);
    const foreign = { ...store(), ownerId: 'another-document' };
    useAppStore.setState({ fatigueLocalCycleSession: foreign });
    const document = useAppStore.getState().document;
    useAppStore.getState().runFatigueLocalCycle();
    useAppStore.getState().saveFatigueLocalCycle();
    expect([useAppStore.getState().fatigueLocalCycleSession, useAppStore.getState().document]).toEqual([foreign, document]);
    const detach = attachFatigueLocalCycle();
    try {
      // Any store change applies the lifecycle: a session of another owner is closed.
      useAppStore.setState({ fatigueLocalCycleSession: foreign });
      expect(useAppStore.getState().fatigueLocalCycleSession).toBeNull();
      useAppStore.getState().openFatigueLocalCycle();
      expect(useAppStore.getState().fatigueLocalCycleSession).not.toBeNull();
      useAppStore.setState({ strengthSession: null });
      expect(useAppStore.getState().fatigueLocalCycleSession).toBeNull();
    } finally {
      detach();
    }
  });
});

describe('FatigueLocalCyclePanel', () => {
  function render(session: FatigueLocalCycleSession): string {
    useAppStore.setState({ fatigueLocalCycleSession: session });
    return renderToStaticMarkup(<FatigueLocalCyclePanel session={session} />);
  }
  it('labels every control, preselects neither correction nor derivation and shows no result before a run', () => {
    const html = render(createFatigueLocalCycleSession(useAppStore.getState().activeDocumentId));
    expect(html).toContain(t('fatigueLocalCycle.scope'));
    expect(html).toContain(t('fatigueLocalCycle.cycleNote'));
    expect((html.match(/<label>/gu) ?? []).length).toBe((html.match(/<(?:input|select|textarea)\b/gu) ?? []).length);
    expect((html.match(/<option value="" selected="">/gu) ?? []).length).toBe(2);
    expect(html).not.toContain('data-testid="fatigue-local-cycle-result"');
    expect(html).not.toContain('role="alert"');
  });
  it('shows the life in cycles for a result and a refusal that never claims a life or no damage', () => {
    const run = runFatigueLocalCycleSession(edited(VALID), 'owner');
    const html = render(run);
    expect(html).toContain('role="status"');
    expect(html).toContain(t('fatigueLocalCycle.cyclesToFailure'));
    expect(html).toContain(t('fatigueLocalCycle.swtParameter'));
    const refused = render(runFatigueLocalCycleSession(edited([...VALID, text('stressMax', '0'), text('stressMin', '-500')]), 'owner'));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain(t('fatigueLocalCycle.error.swtNonpositive'));
    expect(refused).toContain('swt-nonpositive-maximum-stress');
    expect(refused).not.toContain('data-testid="fatigue-local-cycle-result"');
    expect(refused).toMatch(/data-fatigue-local-cycle-field="stressMax"[^>]*aria-invalid="true"/u);
  });
});
