import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beamDisplayNumber } from '../beam/BeamResults.js';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { BASE_EDITS } from '../fatigue/fatigue.testSupport.js';
import { savedFatigueInput } from '../fatigue/fatigueSession.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatigueStrainPanel } from './FatigueStrainPanel.js';
import { attachFatigueStrain } from './attachFatigueStrain.js';
import { createFatigueStrainSession, currentFatigueStrainResult, editFatigueStrainSession, fatigueStrainSaved,
  restoreFatigueStrainSession, runFatigueStrainSession, savedFatigueStrainInput, type FatigueStrainEdit,
  type FatigueStrainSession } from './fatigueStrainSession.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/* Manufactured, test-only coefficients typed as a user would (not SS400, S45C or any real material): b = c = -0.5 and
 * A + B = 1000 / 200000 + 0.995 = 1, so a strain amplitude a lives N = 1 / (2 a ** 2) cycles. The history -2u, 2u
 * (u = 2 ** -8) repeated 10 times is 10 full cycles of amplitude 2u: damage 10 * 8 u ** 2 = 10 / 8192 and the input can
 * be applied 819.2 times. These closed-form values are independent of the solver. */
const u = 2 ** -8;
const EXPECTED_DAMAGE = 10 / 8192, EXPECTED_LIFE = 819.2;
const material = (field: Extract<FatigueStrainEdit, { kind: 'material' }>['field'], value: string): FatigueStrainEdit =>
  ({ kind: 'material', field, value });
const VALID: readonly FatigueStrainEdit[] = [
  material('materialId', 'manufactured'), material('elasticModulusMpa', '200000'),
  material('fatigueStrengthCoefficientMpa', '1000'), material('fatigueStrengthExponent', '-0.5'),
  material('fatigueDuctilityCoefficient', '0.995'), material('fatigueDuctilityExponent', '-0.5'),
  material('minimumCycles', '1'), material('maximumCycles', '1000000'),
  material('materialReference', 'Test-only manufactured coefficients; not a material value'),
  material('materialCondition', 'Hand-derived example'),
  { kind: 'zeroMeanStress', confirmed: true },
  { kind: 'history', index: 0, field: 'id', value: 'h1' },
  { kind: 'historyDerivation', index: 0, value: 'measured' },
  { kind: 'history', index: 0, field: 'strain', value: `${-2 * u}, ${2 * u}` },
  { kind: 'historySequence', index: 0, value: 'repeated-periodic' },
  { kind: 'history', index: 0, field: 'repeats', value: '10' },
  { kind: 'history', index: 0, field: 'reference', value: 'Test-only strain history' },
  { kind: 'history', index: 0, field: 'condition', value: 'Hand-derived example' },
];
const edited = (edits: readonly FatigueStrainEdit[], owner = 'owner'): FatigueStrainSession =>
  edits.reduce(editFatigueStrainSession, createFatigueStrainSession(owner));
const near = (actual: number | undefined, expected: number): void => {
  expect(actual).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(1e-9 * expected);
};
function store(): FatigueStrainSession {
  const value = useAppStore.getState().fatigueStrainSession;
  if (value === null) throw new Error('No strain-life session');
  return value;
}
function openAssemblyWithStrength(): void {
  const fixture = bucklingUiFixture();
  const assembly = fixture.state.assembly;
  if (assembly === null) throw new Error('Fixture without assembly');
  // The real action creates the Undo stack that applyAssembly needs.
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}

describe('strain-life draft', () => {
  it('starts with no value, no assumption and one empty history, and refuses to run', () => {
    const empty = createFatigueStrainSession('owner');
    expect(empty.draft.zeroMeanStressConfirmed).toBe(false);
    expect([empty.draft.elasticModulusMpa, empty.draft.minimumCycles, empty.draft.materialReference]).toEqual(['', '', '']);
    expect(empty.draft.histories).toEqual([{ id: '', derivation: '', strain: '', sequence: '', repeats: '', reference: '',
      condition: '' }]);
    const run = runFatigueStrainSession(empty, 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key: 'fatigueStrain.error.zeroMean', code: null, path: 'meanStress' }]);
  });

  it('runs the actual strain-history analysis with the closed-form damage and life', () => {
    const run = runFatigueStrainSession(edited(VALID), 'owner');
    const result = currentFatigueStrainResult(run);
    near(result?.damage, EXPECTED_DAMAGE);
    near(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : undefined, EXPECTED_LIFE);
    expect(result?.meanStress).toBe('assumed-zero');
    expect(run.refusal).toBeNull();
  });

  it('drops the result on any accepted edit and never shows an earlier result after a refused run', () => {
    const run = runFatigueStrainSession(edited(VALID), 'owner');
    const changed = editFatigueStrainSession(run, material('fatigueStrengthCoefficientMpa', '900'));
    expect([changed.revision, changed.analyzed, currentFatigueStrainResult(changed)]).toEqual([run.revision + 1, null, null]);
    const invalid = runFatigueStrainSession(editFatigueStrainSession(run, material('elasticModulusMpa', '200 GPa')), 'owner');
    expect([invalid.analyzed, invalid.refusal]).toEqual([null, { key: 'fatigueStrain.error.number', code: null, path: 'elasticModulusMpa' }]);
    // A result object whose revision is not the draft's is never treated as current.
    expect(currentFatigueStrainResult({ ...changed, analyzed: run.analyzed })).toBeNull();
  });

  const refusals: [string, FatigueStrainEdit, string, string | null, string][] = [
    ['unconfirmed zero mean stress', { kind: 'zeroMeanStress', confirmed: false }, 'fatigueStrain.error.zeroMean', null, 'meanStress'],
    ['expression instead of a number', material('fatigueStrengthExponent', '-1/2'), 'fatigueStrain.error.number', null,
      'fatigueStrengthExponent'],
    ['text strain', { kind: 'history', index: 0, field: 'strain', value: '0.001 abc' }, 'fatigueStrain.error.strainList', null,
      'histories[0].strain'],
    ['unchosen derivation', { kind: 'historyDerivation', index: 0, value: '' }, 'fatigueStrain.error.derivation', null,
      'histories[0].derivation'],
    ['modulus in GPa (reader)', material('elasticModulusMpa', '206'), 'fatigueStrain.error.input', 'fatigue-strain',
      'material.elasticModulusMpa'],
    ['blank material source (reader)', material('materialReference', ' '), 'fatigueStrain.error.input', 'fatigue-strain', 'material.source'],
    ['cycle beyond the calibrated life (solver)', material('maximumCycles', '1000'), 'fatigueStrain.error.longer',
      'strain-life-longer-than-calibration', 'histories[0].cycles[0]'],
    ['cycle below the calibrated life (solver)', material('minimumCycles', '10000'), 'fatigueStrain.error.shorter',
      'strain-life-shorter-than-calibration', 'histories[0].cycles[0]'],
  ];
  it.each(refusals)('refuses %s with its message, code and path and without a result', (_label, change, key, code, path) => {
    const run = runFatigueStrainSession(editFatigueStrainSession(runFatigueStrainSession(edited(VALID), 'owner'), change), 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key, code, path }]);
  });

  it('ignores edits that cannot apply and keeps 1 to 64 histories', () => {
    const one = edited(VALID);
    expect(editFatigueStrainSession(one, { kind: 'removeHistory', index: 0 })).toBe(one);
    expect(editFatigueStrainSession(one, { kind: 'history', index: 3, field: 'id', value: 'x' })).toBe(one);
    let many = one;
    for (let count = 1; count < 64; count += 1) many = editFatigueStrainSession(many, { kind: 'addHistory' });
    expect(many.draft.histories).toHaveLength(64);
    expect(editFatigueStrainSession(many, { kind: 'addHistory' })).toBe(many);
  });

  it('restores a saved input to a draft that saves the identical input again', () => {
    const checked = fatigueStrainSaved(edited([...VALID, material('fatigueDuctilityCoefficient', '1.2345678901234567e-3')]), 'owner');
    if (!checked.ok) throw new Error(checked.refusal.key);
    const restored = restoreFatigueStrainSession('owner', checked.saved);
    const again = fatigueStrainSaved(restored, 'owner');
    expect(again.ok ? again.saved : null).toEqual(checked.saved);
    expect(restored.analyzed).toBeNull();
  });
});

describe('strain-life inputs in the document', () => {
  it('saves beside the stress-life input through Undo, never stores a result, and restores the draft cold', () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    // An existing stress-life fatigue input must survive every strain-life save.
    useAppStore.getState().openFatigue();
    for (const edit of BASE_EDITS) useAppStore.getState().editFatigue(edit);
    useAppStore.getState().saveFatigue();
    useAppStore.getState().closeFatigue();
    const withStress = useAppStore.getState().assembly;
    if (withStress === null) throw new Error('Assembly closed');
    const stress = savedFatigueInput(withStress);
    expect(stress).not.toBeNull();

    useAppStore.getState().openFatigueStrain();
    expect(store().draft.elasticModulusMpa).toBe('');
    for (const edit of VALID) useAppStore.getState().editFatigueStrain(edit);
    useAppStore.getState().runFatigueStrain();
    near(currentFatigueStrainResult(store())?.damage, EXPECTED_DAMAGE);
    useAppStore.getState().saveFatigueStrain();
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    // The attachment is re-read on every edit, so the stress-life input is an equal fresh value, not the same object.
    expect(savedFatigueInput(assembly)).toEqual(stress);
    const saved = savedFatigueStrainInput(assembly);
    expect([saved?.source.documentId, saved?.input.material.elasticModulusMpa, saved?.input.histories[0]?.strain])
      .toEqual([assembly.id, 200_000, [-2 * u, 2 * u]]);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:damage|life|cycles|analyzed|result|cyclesToFailure)"/u);
    // Saving changes neither the draft nor its revision: the result stays current and the save is reported.
    expect(currentFatigueStrainResult(store())).not.toBeNull();
    expect(store().refusal).toBeNull();

    // Cold restore: the attachment survives a JSON round trip through the real reader, and reopening restores the draft.
    const reread = readBeamAnalysisInputs(JSON.parse(JSON.stringify(assembly.beamAnalysisInputs)), assembly.id);
    expect(reread.ok ? reread.value : null).toEqual(assembly.beamAnalysisInputs);
    useAppStore.getState().closeFatigueStrain();
    useAppStore.getState().openFatigueStrain();
    expect([store().analyzed, store().draft.elasticModulusMpa, store().draft.zeroMeanStressConfirmed]).toEqual([null, '200000', true]);

    // Undo removes only the strain-life input, Redo brings it back.
    useAppStore.getState().undoAssembly();
    const undone = useAppStore.getState().assembly ?? before;
    expect([savedFatigueStrainInput(undone), savedFatigueInput(undone)]).toEqual([null, stress]);
    useAppStore.getState().redoAssembly();
    expect(savedFatigueStrainInput(useAppStore.getState().assembly ?? before)).toEqual(saved);
  });

  it('refuses an unsavable draft without editing the document or its Undo history', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    useAppStore.getState().openFatigueStrain();
    const document = useAppStore.getState().document, canUndo = useAppStore.getState().canUndo;
    for (const edit of VALID) useAppStore.getState().editFatigueStrain(edit);
    useAppStore.getState().editFatigueStrain({ kind: 'zeroMeanStress', confirmed: false });
    useAppStore.getState().saveFatigueStrain();
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().canUndo).toBe(canUndo);
    expect([store().refusal?.key, store().analyzed]).toEqual(['fatigueStrain.error.zeroMean', null]);
  });

  it('does not open without the strength panel and closes when the strength panel closes', () => {
    useAppStore.getState().openFatigueStrain();
    expect(useAppStore.getState().fatigueStrainSession).toBeNull();
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    const detach = attachFatigueStrain();
    try {
      useAppStore.getState().openFatigueStrain();
      expect(useAppStore.getState().fatigueStrainSession).not.toBeNull();
      useAppStore.setState({ strengthSession: null });
      expect(useAppStore.getState().fatigueStrainSession).toBeNull();
    } finally {
      detach();
    }
  });
});

describe('FatigueStrainPanel', () => {
  function render(session: FatigueStrainSession): string {
    useAppStore.setState({ fatigueStrainSession: session });
    return renderToStaticMarkup(<FatigueStrainPanel session={session} />);
  }
  it('labels every control, preselects no choice and shows no result before a run', () => {
    const html = render(createFatigueStrainSession(useAppStore.getState().activeDocumentId));
    expect(html).toContain(t('fatigueStrain.scope'));
    expect(html).toContain(t('fatigueStrain.elasticModulusMpa'));
    // Every input, select and textarea sits inside its <label>; the two choices start unselected.
    expect((html.match(/<label>/gu) ?? []).length).toBe((html.match(/<(?:input|select|textarea)\b/gu) ?? []).length);
    expect((html.match(/<option value="" selected="">/gu) ?? []).length).toBe(2);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked=""/u);
    expect(html).not.toContain('data-testid="fatigue-strain-result"');
    expect(html).not.toContain('role="alert"');
  });
  it('shows the current result with units and the refusal with its code and refused field', () => {
    const run = runFatigueStrainSession(edited(VALID, useAppStore.getState().activeDocumentId), 'owner');
    const result = currentFatigueStrainResult(run);
    if (result === null) throw new Error('Expected a result');
    const html = render(run);
    expect(html).toContain('role="status"');
    expect(html).toContain(t('fatigueStrain.damage'));
    expect(html).toContain(beamDisplayNumber(result.damage));
    expect(html).toContain(t('fatigueStrain.life'));
    const refused = runFatigueStrainSession(editFatigueStrainSession(run, material('maximumCycles', '1000')), 'owner');
    const refusedHtml = render(refused);
    expect(refusedHtml).toContain('role="alert"');
    expect(refusedHtml).toContain(t('fatigueStrain.error.longer'));
    expect(refusedHtml).toContain('strain-life-longer-than-calibration');
    expect(refusedHtml).toContain('histories[0].cycles[0]');
    expect(refusedHtml).not.toContain('data-testid="fatigue-strain-result"');
    const invalidField = render(runFatigueStrainSession(editFatigueStrainSession(run, material('elasticModulusMpa', 'x')), 'owner'));
    expect(invalidField).toMatch(/aria-invalid="true"[^>]*data-fatigue-strain-field="elasticModulusMpa"|data-fatigue-strain-field="elasticModulusMpa"[^>]*aria-invalid="true"/u);
  });
});
