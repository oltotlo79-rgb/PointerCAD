import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bucklingUiFixture } from '../beam/beamBuckling.testSupport.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentFatigueStrainResult, fatigueStrainDraftIsSaved, savedFatigueStrainInput,
  type FatigueStrainEdit, type FatigueStrainSession } from './fatigueStrainSession.js';

beforeEach(() => { resetTestStore(); });
afterEach(() => { resetTestStore(); });

/* Integration regressions for the combined candidate (task005). Manufactured, test-only coefficients typed as a user
 * would (not a real material): b = c = -0.5, A + B = 1000 / 200000 + 0.995 = 1; the history -2u, 2u (u = 2 ** -8)
 * repeated 10 times damages 10 * 8 u ** 2 = 10 / 8192 (closed form, independent of the solver). */
const u = 2 ** -8;
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
  { kind: 'history', index: 0, field: 'strain', value: `${-2 * u} ${2 * u}` },
  { kind: 'historySequence', index: 0, value: 'repeated-periodic' },
  { kind: 'history', index: 0, field: 'repeats', value: '10' },
  { kind: 'history', index: 0, field: 'reference', value: 'Test-only strain history' },
  { kind: 'history', index: 0, field: 'condition', value: 'Hand-derived example' },
];
function session(): FatigueStrainSession {
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
function savedNow() {
  const state = useAppStore.getState();
  return savedFatigueStrainInput(state.assembly ?? state.document);
}

describe('combined strain-life candidate in the document store', () => {
  it('keeps every other analysis input of the assembly unchanged when the strain-life input is saved', () => {
    openAssemblyWithStrength();
    const before = useAppStore.getState().assembly;
    if (before === null) throw new Error('Assembly closed');
    const others = before.beamAnalysisInputs?.analyses ?? [];
    useAppStore.getState().openFatigueStrain();
    for (const edit of VALID) useAppStore.getState().editFatigueStrain(edit);
    useAppStore.getState().saveFatigueStrain();
    const after = useAppStore.getState().assembly;
    expect(after?.beamAnalysisInputs?.analyses.filter(input => input.kind !== 'fatigue-strain-life')).toEqual(others);
    expect(after?.beamAnalysisInputs?.analyses.filter(input => input.kind === 'fatigue-strain-life')).toHaveLength(1);
  });

  it('invalidates the result on edit and on reopen, and follows Undo/Redo of the saved input on reopen', () => {
    openAssemblyWithStrength();
    useAppStore.getState().openFatigueStrain();
    for (const edit of VALID) useAppStore.getState().editFatigueStrain(edit);
    useAppStore.getState().runFatigueStrain();
    const damage = currentFatigueStrainResult(session())?.damage;
    expect(Math.abs((damage ?? Number.NaN) - 10 / 8192)).toBeLessThanOrEqual(1e-9 * (10 / 8192));
    // Edit: the result of the previous revision is gone at once.
    useAppStore.getState().editFatigueStrain({ kind: 'history', index: 0, field: 'repeats', value: '20' });
    expect([session().analyzed, currentFatigueStrainResult(session())]).toEqual([null, null]);
    useAppStore.getState().runFatigueStrain();
    useAppStore.getState().saveFatigueStrain();
    const owner = useAppStore.getState().assembly;
    if (owner === null) throw new Error('Assembly closed');
    expect(fatigueStrainDraftIsSaved(session(), owner.id, savedNow())).toBe(true);
    // Undo removes the saved input: the open draft is no longer saved; reopening starts empty, without any result.
    useAppStore.getState().undoAssembly();
    expect(savedNow()).toBeNull();
    expect(fatigueStrainDraftIsSaved(session(), owner.id, savedNow())).toBe(false);
    useAppStore.getState().closeFatigueStrain();
    useAppStore.getState().openFatigueStrain();
    expect([session().analyzed, session().draft.elasticModulusMpa, session().draft.zeroMeanStressConfirmed]).toEqual([null, '', false]);
    // Redo brings the input back; reopening restores the saved draft, still without a result.
    useAppStore.getState().redoAssembly();
    useAppStore.getState().closeFatigueStrain();
    useAppStore.getState().openFatigueStrain();
    expect([session().analyzed, session().draft.histories[0]?.repeats, session().draft.elasticModulusMpa]).toEqual([null, '20', '200000']);
  });

  it('does not run or save a session that belongs to another document', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ strengthSession: fixture.state.strengthSession, assembly: null });
    useAppStore.getState().openFatigueStrain();
    for (const edit of VALID) useAppStore.getState().editFatigueStrain(edit);
    const foreign = { ...session(), ownerId: 'another-document' };
    useAppStore.setState({ fatigueStrainSession: foreign });
    const document = useAppStore.getState().document;
    useAppStore.getState().runFatigueStrain();
    useAppStore.getState().saveFatigueStrain();
    expect(useAppStore.getState().fatigueStrainSession).toBe(foreign);
    expect(useAppStore.getState().document).toBe(document);
  });

  it('refuses saved attachments with undefined-valued or extra keys before any panel can restore them', () => {
    const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured' };
    const problem = { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero',
      material: { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
        fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
        calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source },
      histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-2 * u, 2 * u], sequence: 'repeated-periodic', repeats: 10, source }] };
    const definition = { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId: 'owner' },
      input: problem };
    const read = (value: unknown) => readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'fatigue-strain-life', definition: value }] }, 'owner').ok;
    expect(read(definition)).toBe(true);
    const variants: unknown[] = [
      { ...definition, input: { ...problem, meanStress: undefined } },
      { ...definition, input: { ...problem, material: { ...problem.material, source: undefined } } },
      { ...definition, input: { ...problem, material: { ...problem.material, calibration: { minimumCycles: 1, maximumCycles: undefined } } } },
      { ...definition, input: { ...problem, histories: [{ ...problem.histories[0], repeats: undefined }] } },
      { ...definition, input: { ...problem, material: { ...problem.material, grade: 'invented' } } },
      { ...definition, analyzed: { damage: 0 } },
    ];
    for (const variant of variants) expect(read(variant)).toBe(false);
  });
});
