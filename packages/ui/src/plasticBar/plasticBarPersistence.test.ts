import { PLASTIC_BAR_INPUT_SCHEMA, PLASTIC_BAR_PLAN_SCHEMA, translatePlasticBar } from '@pointercad/fem';
import { plasticBarSiValues, readBeamAnalysisInputs, withBeamAnalysisInputs,
  type PlasticBarSavedInput } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { BENCHMARK_EDITS, benchmarkResult } from './plasticBar.testSupport.js';
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
      plasticBarSession: edited(BENCHMARK_EDITS.filter(edit => edit.kind !== 'reference')) });
    const before = useAppStore.getState().document;
    useAppStore.getState().savePlasticBar();
    expect(session().errorKey).toBe('plasticBar.error.source');
    expect(useAppStore.getState().document).toBe(before);
    useAppStore.setState({ plasticBarSession: edited(BENCHMARK_EDITS) });
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
              hardeningModulusPa: si.hardeningModulusPa, source: candidate.materialSource },
            endDisplacementM: [...si.endDisplacementM], stepsPerSegment: si.stepsPerSegment } });
      } catch { solver = false; }
      expect(model, JSON.stringify(change)).toBe(solver);
    }
  });
});
