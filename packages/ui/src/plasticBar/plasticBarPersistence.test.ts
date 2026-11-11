import { PLASTIC_BAR_INPUT_SCHEMA, PLASTIC_BAR_PLAN_SCHEMA, translatePlasticBar } from '@pointercad/fem';
import { plasticBarSiValues, readBeamAnalysisInputs, withBeamAnalysisInputs,
  type PlasticBarSavedInput } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BENCHMARK_EDITS, PLATEAU_EDITS, benchmarkResult } from './plasticBar.testSupport.js';
import { createPlasticBarSession, editPlasticBarSession, plasticBarDraftIsSaved, plasticBarInput, plasticBarSavedInput,
  restorePlasticBarSession, savedPlasticBarInput, type PlasticBarEdit, type PlasticBarSession } from './plasticBarSession.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

function edited(edits: readonly PlasticBarEdit[], ownerId = 'session-owner'): PlasticBarSession {
  let session = createPlasticBarSession(ownerId);
  for (const edit of edits) session = editPlasticBarSession(session, edit);
  return session;
}
function session(): PlasticBarSession {
  const value = useAppStore.getState().plasticBarSession;
  if (value === null) throw new Error('No plastic-bar session');
  return value;
}
function savedOf(session: PlasticBarSession, documentId: string): PlasticBarSavedInput {
  const checked = plasticBarSavedInput(session, [], documentId);
  if (!checked.ok) throw new Error(`Draft not savable: ${checked.key} ${checked.diagnostic ?? ''}`);
  return checked.saved;
}

describe('plastic-bar configuration persistence', () => {
  it('restores every field to the same double and the same solver plan, also for values that are not short decimals', () => {
    const awkward: readonly PlasticBarEdit[] = [...BENCHMARK_EDITS,
      { kind: 'value', field: 'length', source: '1000/3' }, { kind: 'value', field: 'area', source: '0.1+0.2' },
      { kind: 'value', field: 'young', source: '210000+1/7' }, { kind: 'knot', index: 1, source: '-1/3' }];
    for (const edits of [BENCHMARK_EDITS, awkward]) {
      const original = edited(edits);
      const stored = savedOf(original, 'document-a');
      const restored = restorePlasticBarSession('session-owner', stored);
      expect(savedOf(restored, 'document-a')).toEqual(stored);
      const before = plasticBarInput(original, []), after = plasticBarInput(restored, []);
      if (!before.ok || !after.ok) throw new Error('Expected runnable drafts');
      expect(after.input.plan).toEqual(before.input.plan);
      // Restored sources never use exponent notation, which the expression grammar cannot read back.
      expect(Object.values(restored.draft.values).concat(restored.draft.knots).some(source => /e/iu.test(source))).toBe(false);
      expect(restored.result).toBeNull();
      expect(restored.status).toBe('editing');
    }
  });

  it('saves into the open assembly, keeps other inputs, reopens without a result and reports unsaved edits', async () => {
    const fixture = bucklingUiFixture();
    const fixtureAssembly = fixture.state.assembly;
    if (fixtureAssembly === null) throw new Error('Fixture without assembly');
    // Opening through the real action creates the Undo stack required by applyAssembly.
    // Spreading the publication-only fixture left that stack null, so saving was correctly refused.
    useAppStore.getState().openAssembly(fixtureAssembly, fixture.state.assemblyLibrary);
    useAppStore.setState({ strengthSession: fixture.state.strengthSession });
    expect(useAppStore.getState().assemblyUndoStack).not.toBeNull();
    const assemblyBefore = useAppStore.getState().assembly;
    if (assemblyBefore === null) throw new Error('Fixture without assembly');
    const othersBefore = assemblyBefore.beamAnalysisInputs?.analyses ?? [];
    useAppStore.getState().openPlasticBar();
    for (const edit of BENCHMARK_EDITS) useAppStore.getState().editPlasticBar(edit);
    const runnable = plasticBarInput(session(), []);
    if (!runnable.ok) throw new Error('Expected a runnable draft');
    // A current result exists before saving; it must not enter the document.
    useAppStore.setState({ plasticBarSession: { ...session(), status: 'complete', result: await benchmarkResult(runnable.input) } });
    useAppStore.getState().savePlasticBar();
    expect(useAppStore.getState().canUndo).toBe(true);
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('Assembly closed');
    expect(assembly.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'plastic-bar')).toEqual(othersBefore);
    const stored = savedPlasticBarInput(assembly);
    expect(stored?.source.documentId).toBe(assembly.id);
    expect(JSON.stringify(assembly.beamAnalysisInputs)).not.toMatch(/"(?:samples|result|inputSha256|status)"/u);
    expect(session().result).not.toBeNull();
    expect(plasticBarDraftIsSaved(session(), [], stored)).toBe(true);
    useAppStore.getState().closePlasticBar();
    useAppStore.getState().openPlasticBar();
    expect(session().result).toBeNull();
    expect(session().status).toBe('editing');
    expect(plasticBarDraftIsSaved(session(), [], stored)).toBe(true);
    useAppStore.getState().editPlasticBar({ kind: 'value', field: 'hardening', source: '0' });
    expect(plasticBarDraftIsSaved(session(), [], savedPlasticBarInput(assembly))).toBe(false);
    // Saving again replaces the single configuration.
    useAppStore.getState().savePlasticBar();
    const again = useAppStore.getState().assembly?.beamAnalysisInputs?.analyses.filter(input => input.kind === 'plastic-bar');
    expect(again).toHaveLength(1);
    expect(again?.[0]?.kind === 'plastic-bar' ? again[0].definition.hardeningModulusMPa : null).toBe(0);
  });

  it('saves into the part document when no assembly is open and refuses an unsavable draft without editing it', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null,
      plasticBarSession: edited(BENCHMARK_EDITS.filter(edit => edit.kind !== 'reference'), useAppStore.getState().activeDocumentId) });
    const before = useAppStore.getState().document;
    useAppStore.getState().savePlasticBar();
    expect(session().errorKey).toBe('plasticBar.error.source');
    expect(useAppStore.getState().document).toBe(before);
    useAppStore.setState({ plasticBarSession: edited(BENCHMARK_EDITS, useAppStore.getState().activeDocumentId) });
    useAppStore.getState().savePlasticBar();
    const part = useAppStore.getState().document;
    expect(savedPlasticBarInput(part)?.source.documentId).toBe(part.id);
    expect(savedPlasticBarInput(before)).toBeNull();
  });

  it('keeps documents independent: a configuration of one document is refused by another', () => {
    const stored = savedOf(edited(BENCHMARK_EDITS), 'document-a');
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'plastic-bar', definition: stored }] };
    expect(readBeamAnalysisInputs(attachment, 'document-a').ok).toBe(true);
    const foreign = readBeamAnalysisInputs(attachment, 'document-b');
    expect(foreign.ok ? null : foreign.issue.code).toBe('wrong-document');
    expect(() => withBeamAnalysisInputs({ id: 'document-b' }, attachment)).toThrow('wrong-document');
  });

  it('accepts exactly what the solver plan accepts at the rule boundaries (same SI numbers, same comparisons)', () => {
    const base = savedOf(edited(BENCHMARK_EDITS), 'document-a');
    const cases: readonly Partial<PlasticBarSavedInput>[] = [
      {}, { endDisplacementMm: [0, 50, -50] }, { endDisplacementMm: [0, 50.000001] }, { yieldStressMPa: 200000 },
      { yieldStressMPa: 199999.99999999997 }, { poisson: 0.5 }, { poisson: 0 }, { hardeningModulusMPa: 0 },
      { hardeningModulusMPa: -1e-300 }, { lengthMm: 500000 }, { lengthMm: 500000.0000000001, endDisplacementMm: [0, 1] },
      { areaMm2: 1000000 }, { areaMm2: 1000000.0000000001 }, { stepsPerSegment: 200, endDisplacementMm: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
      { stepsPerSegment: 201 }, { lengthMm: 5e-324, endDisplacementMm: [0, 1e-320] },
      // Optional plateau (a fraction): (0, 0.05] accepted, 0 / -0 / negative / above 0.05 / non-finite refused by both.
      { plateauPlasticStrain: 0.05 }, { plateauPlasticStrain: 0.05000000000000001 }, { plateauPlasticStrain: 0.01 },
      { plateauPlasticStrain: 5e-324 }, { plateauPlasticStrain: 0 }, { plateauPlasticStrain: -0 },
      { plateauPlasticStrain: -0.001 }, { plateauPlasticStrain: Number.NaN },
      { plateauPlasticStrain: Number.POSITIVE_INFINITY },
    ];
    for (const change of cases) {
      const candidate = { ...base, ...change };
      const model = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
        analyses: [{ kind: 'plastic-bar', definition: candidate }] }, 'document-a').ok;
      const si = plasticBarSiValues(candidate);
      let solver = true;
      try {
        translatePlasticBar({ schema: PLASTIC_BAR_INPUT_SCHEMA, source: { documentId: 'document-a', revision: 0 },
          plan: { schema: PLASTIC_BAR_PLAN_SCHEMA, lengthM: si.lengthM, areaM2: si.areaM2,
            material: { youngPa: si.youngPa, poisson: si.poisson, yieldStressPa: si.yieldStressPa,
              hardeningModulusPa: si.hardeningModulusPa,
              ...(si.plateauPlasticStrain === undefined ? {} : { plateauPlasticStrain: si.plateauPlasticStrain }),
              source: candidate.materialSource },
            endDisplacementM: [...si.endDisplacementM], stepsPerSegment: si.stepsPerSegment } });
      } catch { solver = false; }
      expect(model, JSON.stringify(change)).toBe(solver);
    }
    // Independently stated expectations for the plateau rows (not only model == solver).
    const accepts = (kp: number): boolean => readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'plastic-bar', definition: { ...base, plateauPlasticStrain: kp } }] }, 'document-a').ok;
    expect([0.05, 0.01, 5e-324].map(accepts)).toEqual([true, true, true]);
    expect([0.05000000000000001, 0, -0, -0.001, Number.NaN, Number.POSITIVE_INFINITY].map(accepts))
      .toEqual([false, false, false, false, false, false]);
  });
});

describe('plastic-bar yield plateau input (plateauPlasticStrain, a cumulative plastic strain fraction)', () => {
  const plateau = (source: string): readonly PlasticBarEdit[] => [...BENCHMARK_EDITS, { kind: 'value', field: 'plateau', source }];

  it('reads 1% as 0.01 and 0.5% as 0.005, the same doubles as the plain fractions, and passes them unchanged to the plan', () => {
    const cases: readonly (readonly [string, string, number])[] = [['1%', '0.01', 0.01], ['0.5%', '0.005', 0.005],
      ['5%', '0.05', 0.05]];
    for (const [percent, fraction, expected] of cases) {
      const fromPercent = savedOf(edited(plateau(percent)), 'document-a');
      const fromFraction = savedOf(edited(plateau(fraction)), 'document-a');
      expect(fromPercent.plateauPlasticStrain, percent).toBe(expected);
      expect(fromFraction.plateauPlasticStrain, fraction).toBe(expected);
      const input = plasticBarInput(edited(plateau(percent)), []);
      if (!input.ok) throw new Error(`Expected a runnable plateau draft for ${percent}`);
      expect(input.input.plan.material.plateauPlasticStrain).toBe(expected);
      // The other material values are unchanged by the plateau (SI conversion of the benchmark).
      expect(input.input.plan.material.yieldStressPa).toBe(250e6);
      expect(input.input.plan.material.hardeningModulusPa).toBe(2e9);
    }
  });

  it('round-trips the saved fraction exactly through the panel text, with no x100 and no exponent text', () => {
    for (const source of ['1%', '0.5%', '1/3%', '0.05', '0.0123456789']) {
      const stored = savedOf(edited(plateau(source)), 'document-a');
      const restored = restorePlasticBarSession('session-owner', stored);
      expect(restored.draft.values.plateau, source).not.toMatch(/[%e]/iu);
      expect(savedOf(restored, 'document-a')).toEqual(stored);
      expect(plasticBarDraftIsSaved(restored, [], stored)).toBe(true);
      const read = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
        analyses: [{ kind: 'plastic-bar', definition: stored }] }, 'document-a');
      if (!read.ok) throw new Error(`Saved plateau refused: ${read.issue.code}`);
      const definition = read.value.analyses[0]?.kind === 'plastic-bar' ? read.value.analyses[0].definition : null;
      expect(definition?.plateauPlasticStrain).toBe(stored.plateauPlasticStrain);
    }
    expect(restorePlasticBarSession('session-owner', savedOf(edited(plateau('1%')), 'document-a')).draft.values.plateau)
      .toBe('0.01');
  });

  it('an empty plateau keeps the original law: no saved key, the same saved form and the same plan as before the field existed', () => {
    const legacy = savedOf(edited(BENCHMARK_EDITS), 'document-a');
    for (const source of ['', '   ']) {
      const blank = savedOf(edited(plateau(source)), 'document-a');
      expect(Object.hasOwn(blank, 'plateauPlasticStrain')).toBe(false);
      expect(blank).toEqual(legacy);
      expect(JSON.stringify(blank)).toBe(JSON.stringify(legacy));
      const before = plasticBarInput(edited(BENCHMARK_EDITS), []), after = plasticBarInput(edited(plateau(source)), []);
      if (!before.ok || !after.ok) throw new Error('Expected runnable drafts');
      expect(Object.hasOwn(after.input.plan.material, 'plateauPlasticStrain')).toBe(false);
      // The extra field edit advances the session revision even when its trimmed value is empty.
      expect(after.input.source.revision).toBe(before.input.source.revision + 1);
      expect(after.input).toEqual({ ...before.input,
        source: { ...before.input.source, revision: before.input.source.revision + 1 } });
    }
    // An old configuration without the key restores with an empty plateau and saves back to the same form.
    const restored = restorePlasticBarSession('session-owner', legacy);
    expect(restored.draft.values.plateau).toBe('');
    expect(JSON.stringify(savedOf(restored, 'document-a'))).toBe(JSON.stringify(legacy));
  });

  it('refuses 0, negative, above 0.05 and non-numbers before saving or running, and leaves the document unchanged', () => {
    for (const source of ['0', '0%', '-0.001', '-1%', '0.0500001', '5.0001%', '6%', 'abc', '1 mm']) {
      const draft = edited(plateau(source));
      const save = plasticBarSavedInput(draft, [], 'document-a'), run = plasticBarInput(draft, []);
      expect(save.ok, source).toBe(false);
      expect(run.ok, source).toBe(false);
    }
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null,
      plasticBarSession: edited(plateau('0'), useAppStore.getState().activeDocumentId) });
    const before = useAppStore.getState().document;
    useAppStore.getState().savePlasticBar();
    expect(useAppStore.getState().document).toBe(before);
    expect(session().errorKey).not.toBeNull();
  });

  it('refuses a saved file with a plateau outside the range or of the wrong type, with the field path', () => {
    const base = savedOf(edited(BENCHMARK_EDITS), 'document-a');
    for (const value of [0, -0.01, 0.06, '0.01', '1%', null, Number.NaN]) {
      const read = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
        analyses: [{ kind: 'plastic-bar', definition: { ...base, plateauPlasticStrain: value } }] }, 'document-a');
      expect(read.ok, String(value)).toBe(false);
      expect(read.ok ? '' : read.issue.path, String(value)).toContain('plateauPlasticStrain');
    }
  });

  it('saves the plateau into the part document, reopens it without a result and reports a later plateau edit as unsaved', async () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null,
      plasticBarSession: edited(PLATEAU_EDITS, useAppStore.getState().activeDocumentId) });
    const runnable = plasticBarInput(session(), []);
    if (!runnable.ok) throw new Error('Expected a runnable plateau draft');
    useAppStore.setState({ plasticBarSession: { ...session(), status: 'complete', result: await benchmarkResult(runnable.input) } });
    useAppStore.getState().savePlasticBar();
    const part = useAppStore.getState().document;
    const stored = savedPlasticBarInput(part);
    expect(stored?.plateauPlasticStrain).toBe(0.01);
    expect(JSON.stringify(stored)).not.toMatch(/"(?:samples|result|inputSha256|status|method|scope)"/u);
    useAppStore.getState().closePlasticBar();
    useAppStore.getState().openPlasticBar();
    expect(session().result).toBeNull();
    expect(session().draft.values.plateau).toBe('0.01');
    expect(plasticBarDraftIsSaved(session(), [], stored)).toBe(true);
    useAppStore.getState().editPlasticBar({ kind: 'value', field: 'plateau', source: '' });
    expect(plasticBarDraftIsSaved(session(), [], stored)).toBe(false);
    useAppStore.getState().savePlasticBar();
    const cleared = savedPlasticBarInput(useAppStore.getState().document);
    expect(cleared === null ? null : Object.hasOwn(cleared, 'plateauPlasticStrain')).toBe(false);
  });
});
