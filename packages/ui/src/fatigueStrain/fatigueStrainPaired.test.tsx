import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FatigueStrainPanel } from './FatigueStrainPanel.js';
import { fatigueStrainLifecycle } from './attachFatigueStrain.js';
import { createFatigueStrainSession, currentFatigueStrainResult, editFatigueStrainSession, fatigueStrainSamples, fatigueStrainSaved,
  restoreFatigueStrainSession, runFatigueStrainSession, savedFatigueStrainConfiguration, savedFatigueStrainInput,
  type FatigueStrainEdit, type FatigueStrainSession } from './fatigueStrainSession.js';

beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/* Manufactured, test-only coefficients typed as a user would (not SS400, S45C or any real material): b = c = -0.5,
 * sigma_f' = 1000 MPa, E = 200000 MPa, eps_f' = 0.995. With the existing Morrow elastic term the amplitude a of a cycle
 * of mean stress s lives N = ((1000 - s) / 200000 + 0.995) ** 2 / (2 a ** 2). The typed samples (0 s, -2u, -100 MPa) and
 * (0.5 s, 2u, 300 MPa) with u = 2 ** -8, repeated 10 times, are 10 cycles of amplitude 2u and paired mean stress 100 MPa:
 * N = 8192 * 0.9995 ** 2 and the damage is 10 / N. The stresses are typed values; nothing computes a stress from a strain. */
const u = 2 ** -8;
const PAIRED_N = 8192 * 0.9995 ** 2;
const EXPECTED_DAMAGE = 10 / PAIRED_N;
const SAMPLES = `0 ${-2 * u} -100\n0.5 ${2 * u} 300`;
const material = (field: Extract<FatigueStrainEdit, { kind: 'material' }>['field'], value: string): FatigueStrainEdit =>
  ({ kind: 'material', field, value });
const history = (field: Extract<FatigueStrainEdit, { kind: 'history' }>['field'], value: string): FatigueStrainEdit =>
  ({ kind: 'history', index: 0, field, value });
const PAIRED: readonly FatigueStrainEdit[] = [
  material('materialId', 'manufactured'), material('elasticModulusMpa', '200000'),
  material('fatigueStrengthCoefficientMpa', '1000'), material('fatigueStrengthExponent', '-0.5'),
  material('fatigueDuctilityCoefficient', '0.995'), material('fatigueDuctilityExponent', '-0.5'),
  material('minimumCycles', '1'), material('maximumCycles', '1000000'),
  material('materialReference', 'Test-only manufactured coefficients; not a material value'),
  material('materialCondition', 'Hand-derived example'),
  { kind: 'historyKind', value: 'paired-stress' },
  history('id', 'h1'), { kind: 'historyDerivation', index: 0, value: 'elastic-plastic-analysis' },
  history('samples', SAMPLES), { kind: 'historySequence', index: 0, value: 'repeated-periodic' },
  history('repeats', '10'), history('reference', 'Test-only paired history'), history('condition', 'Hand-derived example'),
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
  useAppStore.getState().openAssembly(assembly, fixture.state.assemblyLibrary);
  useAppStore.setState({ strengthSession: fixture.state.strengthSession });
}

describe('paired strain-stress draft', () => {
  it('keeps the strain-only default and makes the kind an explicit accepted edit', () => {
    const empty = createFatigueStrainSession('owner');
    expect([empty.draft.historyKind, empty.draft.zeroMeanStressConfirmed]).toEqual(['strain-only', false]);
    const paired = editFatigueStrainSession(empty, { kind: 'historyKind', value: 'paired-stress' });
    expect([paired.revision, paired.draft.historyKind]).toEqual([1, 'paired-stress']);
    expect(editFatigueStrainSession(paired, { kind: 'historyKind', value: 'paired-stress' })).toBe(paired);
  });

  it('reads one sample per line in the typed order and names the first line that is not three numbers', () => {
    expect(fatigueStrainSamples('0 -0.5 -100\r\n1,0.5;300\n\n  ')).toEqual({ ok: true, samples: [
      { timeSeconds: 0, strain: -0.5, stressMpa: -100 }, { timeSeconds: 1, strain: 0.5, stressMpa: 300 }] });
    // Typed order is kept (no sorting); time order is the model reader's refusal, not silently repaired here.
    expect(fatigueStrainSamples('1 0 0\n0 0 0')).toEqual({ ok: true, samples: [
      { timeSeconds: 1, strain: 0, stressMpa: 0 }, { timeSeconds: 0, strain: 0, stressMpa: 0 }] });
    const lines: [string, number][] = [['', 0], ['time strain stress\n0 0 0', 0], ['0 0 0\n0.5 0.001', 1], ['0 0 0\n\n1 0 0', 1],
      ['0 0 0\n1 0 0 5', 1], ['0 0 300MPa', 0], ['0 0 1/2', 0], ['\n0 0 0', 0]];
    for (const [text, line] of lines) expect(fatigueStrainSamples(text)).toEqual({ ok: false, line });
  });

  it('runs the paired analysis with the closed-form Morrow damage and states its mean-stress applicability', () => {
    const run = runFatigueStrainSession(edited(PAIRED), 'owner');
    const result = currentFatigueStrainResult(run);
    expect(run.refusal).toBeNull();
    near(result?.damage, EXPECTED_DAMAGE);
    near(result?.life.kind === 'finite' ? result.life.spectrumRepetitions : undefined, PAIRED_N / 10);
    expect(result?.meanStress).toBe('morrow-paired-reversal-stress');
    expect(result?.meanStress === 'morrow-paired-reversal-stress' ? result.histories[0]?.cycles.map(cycle => cycle.meanStressMpa) : null)
      .toEqual(result?.histories[0]?.cycles.map(() => 100));
    // The zero-mean statement is not needed and not used by the paired kind.
    expect(run.draft.zeroMeanStressConfirmed).toBe(false);
  });

  it('never analyses the strain list of the other kind or invents stresses for it', () => {
    const typedStrainOnly = edited([...PAIRED, history('samples', ''), history('strain', `${-2 * u} ${2 * u}`)]);
    const run = runFatigueStrainSession(typedStrainOnly, 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key: 'fatigueStrain.error.sampleLine', code: null,
      path: 'histories[0].samples[0]' }]);
  });

  const refusals: [string, readonly FatigueStrainEdit[], string, string | null, string][] = [
    ['a sample line of two numbers', [history('samples', `0 ${-2 * u} -100\n0.5 ${2 * u}`)], 'fatigueStrain.error.sampleLine', null,
      'histories[0].samples[1]'],
    ['a stress with its unit typed', [history('samples', `0 ${-2 * u} -100MPa\n0.5 ${2 * u} 300`)], 'fatigueStrain.error.sampleLine', null,
      'histories[0].samples[0]'],
    ['a repeated time (reader)', [history('samples', `0 ${-2 * u} -100\n0 ${2 * u} 300`)], 'fatigueStrain.error.input', 'fatigue-strain',
      'histories[0].samples[1].timeSeconds'],
    ['a reordered time (reader)', [history('samples', `1 ${-2 * u} -100\n0.5 ${2 * u} 300`)], 'fatigueStrain.error.input',
      'fatigue-strain', 'histories[0].samples[1].timeSeconds'],
    ['a stress in Pa (reader)', [history('samples', `0 ${-2 * u} -100e6\n0.5 ${2 * u} 300`)], 'fatigueStrain.error.input',
      'fatigue-strain', 'histories[0].samples[0].stressMpa'],
    ['an unchosen derivation', [{ kind: 'historyDerivation', index: 0, value: '' }], 'fatigueStrain.error.derivation', null,
      'histories[0].derivation'],
    ['two stresses on one reversal plateau (solver)', [history('samples', `0 ${-2 * u} -100\n1 ${2 * u} 300\n2 ${2 * u} 250`),
      { kind: 'historySequence', index: 0, value: 'once' }, history('repeats', '1')], 'fatigueStrain.error.ambiguousStress',
    'strain-stress-history-ambiguous-reversal-stress', 'histories[0].samples[2].stressMpa'],
    ['a periodic history closing on another stress (solver)', [history('samples', `0 ${-2 * u} -100\n0.5 ${2 * u} 300\n1 ${-2 * u} -90`)],
      'fatigueStrain.error.periodicClosure', 'strain-stress-history-periodic-closure', 'histories[0].samples[2].stressMpa'],
    // Mean stress (1000 + 1200) / 2 = 1100 MPa is not below sigma_f' = 1000 MPa: outside the Morrow domain.
    ['a mean stress at or above sigma_f\' (solver)', [history('samples', `0 ${-2 * u} 1000\n0.5 ${2 * u} 1200`)],
      'fatigueStrain.error.morrowDomain', 'strain-life-morrow-domain', 'histories[0].cycles[0]'],
    ['a life beyond the calibrated interval (solver)', [material('maximumCycles', '1000')], 'fatigueStrain.error.longer',
      'strain-life-longer-than-calibration', 'histories[0].cycles[0]'],
  ];
  it.each(refusals)('refuses %s with its message, code and path and without a result', (_label, changes, key, code, path) => {
    const run = runFatigueStrainSession(changes.reduce(editFatigueStrainSession, runFatigueStrainSession(edited(PAIRED), 'owner')), 'owner');
    expect([run.analyzed, run.refusal]).toEqual([null, { key, code, path }]);
  });
});

describe('paired results are never stale', () => {
  it('drops the result on an edit and on a change of kind, and refuses a result put back after the edit', () => {
    const run = runFatigueStrainSession(edited(PAIRED), 'owner');
    expect(currentFatigueStrainResult(run)).not.toBeNull();
    const changed = editFatigueStrainSession(run, history('samples', `0 ${-2 * u} -100\n0.5 ${2 * u} 310`));
    expect([changed.analyzed, currentFatigueStrainResult({ ...changed, analyzed: run.analyzed })]).toEqual([null, null]);
    const kind = editFatigueStrainSession(run, { kind: 'historyKind', value: 'strain-only' });
    expect([kind.analyzed, currentFatigueStrainResult({ ...kind, analyzed: run.analyzed })]).toEqual([null, null]);
  });

  it('refuses a result of an earlier opening put back on a reopened draft of the same revision', () => {
    const checked = fatigueStrainSaved(edited(PAIRED), 'owner');
    if (!checked.ok) throw new Error(checked.refusal.key);
    const first = runFatigueStrainSession(restoreFatigueStrainSession('owner', checked.saved), 'owner');
    expect(currentFatigueStrainResult(first)).not.toBeNull();
    const reopened = restoreFatigueStrainSession('owner', checked.saved);
    // Same revision 0 and equal text, but another opening: a revision-only check would have shown the old result.
    expect([reopened.revision, first.revision]).toEqual([0, 0]);
    expect(currentFatigueStrainResult({ ...reopened, analyzed: first.analyzed })).toBeNull();
  });

  it('restores the exact typed samples, without a zero-mean statement, to a draft that saves the identical input again', () => {
    // 0.1 + 0.2 is the double 0.30000000000000004; 1e2 is typed text whose value is 100.
    const awkward = `0 ${-2 * u} ${0.1 + 0.2}\n0.5 ${2 * u} 1e2`;
    const checked = fatigueStrainSaved(edited([...PAIRED, history('samples', awkward)]), 'owner');
    if (!checked.ok) throw new Error(checked.refusal.key);
    const restored = restoreFatigueStrainSession('owner', checked.saved);
    expect([restored.draft.historyKind, restored.draft.zeroMeanStressConfirmed, restored.draft.histories[0]?.strain, restored.analyzed])
      .toEqual(['paired-stress', false, '', null]);
    expect(restored.draft.histories[0]?.samples).toBe('0 -0.0078125 0.30000000000000004\n0.5 0.0078125 100');
    const again = fatigueStrainSaved(restored, 'owner');
    expect(again.ok ? again.saved : null).toEqual(checked.saved);
  });

  it('closes the panel with its result when another document becomes active or the strength panel closes', () => {
    const run = runFatigueStrainSession(edited(PAIRED, 'owner'), 'owner');
    const strengthSession = bucklingUiFixture().state.strengthSession;
    expect(fatigueStrainLifecycle({ fatigueStrainSession: run, strengthSession, activeDocumentId: 'owner' }).fatigueStrainSession).toBe(run);
    expect(fatigueStrainLifecycle({ fatigueStrainSession: run, strengthSession, activeDocumentId: 'replaced' }).fatigueStrainSession).toBeNull();
    expect(fatigueStrainLifecycle({ fatigueStrainSession: run, strengthSession: null, activeDocumentId: 'owner' }).fatigueStrainSession).toBeNull();
  });
});

describe('paired inputs in the document', () => {
  it('saves through Undo, reopens the exact samples without a result, and keeps one configuration per document', () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    useAppStore.getState().openFatigueStrain();
    for (const edit of PAIRED) useAppStore.getState().editFatigueStrain(edit);
    useAppStore.getState().runFatigueStrain();
    near(currentFatigueStrainResult(store())?.damage, EXPECTED_DAMAGE);
    useAppStore.getState().saveFatigueStrain();
    expect(store().refusal).toBeNull();
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    const saved = savedFatigueStrainConfiguration(assembly);
    expect([saved?.schema, saved?.input.meanStress, savedFatigueStrainInput(assembly)])
      .toEqual(['pointercad-fatigue-strain-stress-saved/1', 'morrow-paired-reversal-stress', null]);
    expect(saved?.schema === 'pointercad-fatigue-strain-stress-saved/1' ? saved.input.histories[0]?.samples : null).toEqual([
      { timeSeconds: 0, strain: -2 * u, stressMpa: -100 }, { timeSeconds: 0.5, strain: 2 * u, stressMpa: 300 }]);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:damage|life|cycles|analyzed|result|cyclesToFailure|meanStressMpa)"/u);
    const reread = readBeamAnalysisInputs(JSON.parse(JSON.stringify(assembly.beamAnalysisInputs)), assembly.id);
    expect(reread.ok ? reread.value : null).toEqual(assembly.beamAnalysisInputs);

    // Reopen: the paired draft comes back exactly, without any result.
    useAppStore.getState().closeFatigueStrain();
    useAppStore.getState().openFatigueStrain();
    expect([store().analyzed, store().draft.historyKind, store().draft.histories[0]?.samples]).toEqual([null, 'paired-stress', SAMPLES]);

    // Changing the kind and saving replaces the one strain-life configuration of the document.
    useAppStore.getState().editFatigueStrain({ kind: 'historyKind', value: 'strain-only' });
    useAppStore.getState().editFatigueStrain(history('strain', `${-2 * u} ${2 * u}`));
    useAppStore.getState().editFatigueStrain({ kind: 'zeroMeanStress', confirmed: true });
    useAppStore.getState().saveFatigueStrain();
    const zeroMean = useAppStore.getState().assembly;
    expect(zeroMean?.beamAnalysisInputs?.analyses.filter(input => input.kind === 'fatigue-strain-life')).toHaveLength(1);
    expect(savedFatigueStrainInput(zeroMean ?? before)?.input.meanStress).toBe('assumed-zero');

    // Undo brings the paired configuration back; a second Undo removes it.
    useAppStore.getState().undoAssembly();
    expect(savedFatigueStrainConfiguration(useAppStore.getState().assembly ?? before)).toEqual(saved);
    useAppStore.getState().undoAssembly();
    expect(savedFatigueStrainConfiguration(useAppStore.getState().assembly ?? before)).toBeNull();
  });

  it('refuses an unsavable paired draft without editing the document or its Undo history', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    useAppStore.getState().openFatigueStrain();
    const document = useAppStore.getState().document, canUndo = useAppStore.getState().canUndo;
    for (const edit of PAIRED) useAppStore.getState().editFatigueStrain(edit);
    useAppStore.getState().editFatigueStrain(history('samples', `0 ${-2 * u} -100\n0 ${2 * u} 300`));
    useAppStore.getState().saveFatigueStrain();
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().canUndo).toBe(canUndo);
    expect([store().refusal?.path, store().analyzed]).toEqual(['histories[0].samples[1].timeSeconds', null]);
  });
});

describe('FatigueStrainPanel with paired samples', () => {
  function render(session: FatigueStrainSession): string {
    useAppStore.setState({ fatigueStrainSession: session });
    return renderToStaticMarkup(<FatigueStrainPanel session={session} />);
  }
  it('shows the sample field with its units and format instead of the zero-mean statement, every control labelled', () => {
    const html = render(edited([{ kind: 'historyKind', value: 'paired-stress' }], useAppStore.getState().activeDocumentId));
    expect(html).toContain(t('fatigueStrain.samples'));
    expect(html).toContain(t('fatigueStrain.samplesFormat'));
    expect(html).toContain(t('fatigueStrain.pairedNote'));
    expect(html).toContain(t('fatigueStrain.scopePaired'));
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('data-fatigue-strain-field="histories[0].strain"');
    expect((html.match(/<label>/gu) ?? []).length).toBe((html.match(/<(?:input|select|textarea)\b/gu) ?? []).length);
  });
  it('shows the applicability of each result and marks the refused sample', () => {
    const paired = runFatigueStrainSession(edited(PAIRED, useAppStore.getState().activeDocumentId), 'owner');
    const pairedHtml = render(paired);
    expect(pairedHtml).toContain('data-mean-stress="morrow-paired-reversal-stress"');
    expect(pairedHtml).toContain(t('fatigueStrain.applicabilityPaired'));
    expect(pairedHtml).toContain('data-testid="fatigue-strain-mean-stress-h1"');
    const zeroMean = runFatigueStrainSession(editFatigueStrainSession(editFatigueStrainSession(editFatigueStrainSession(paired,
      { kind: 'historyKind', value: 'strain-only' }), history('strain', `${-2 * u} ${2 * u}`)), { kind: 'zeroMeanStress', confirmed: true }),
    'owner');
    const zeroMeanHtml = render(zeroMean);
    expect(zeroMeanHtml).toContain('data-mean-stress="assumed-zero"');
    expect(zeroMeanHtml).toContain(t('fatigueStrain.applicabilityZeroMean'));
    expect(zeroMeanHtml).not.toContain(t('fatigueStrain.applicabilityPaired'));
    const refused = render(runFatigueStrainSession(editFatigueStrainSession(paired,
      history('samples', `0 ${-2 * u} -100\n0 ${2 * u} 300`)), 'owner'));
    expect(refused).toContain('histories[0].samples[1].timeSeconds');
    expect(refused).toMatch(/aria-invalid="true"[^>]*data-fatigue-strain-field="histories\[0\]\.samples"|data-fatigue-strain-field="histories\[0\]\.samples"[^>]*aria-invalid="true"/u);
    expect(refused).not.toContain('data-testid="fatigue-strain-result"');
  });
});
