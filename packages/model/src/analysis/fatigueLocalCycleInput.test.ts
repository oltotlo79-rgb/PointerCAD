import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './index.js';
import { FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA, createFatigueLocalCycleSavedInput, readFatigueLocalCycleSavedInput } from './fatigueLocalCycleInput.js';
import { FATIGUE_SAVED_GOODMAN_SCHEMA } from './fatigueInput.js';

/** Synthetic values written out here (manufactured coefficients, not a real material); every expected code and path
 * below is written by hand from the saved format, not taken from the reader. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured local cycle' };
function problem() {
  return { schema: 'pointercad-strain-life-local-cycle/1', correction: 'swt',
    material: { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
      fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
      calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source },
    cycle: { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'measured',
      strainMax: 0.01, strainMin: -0.01, stressMax: 500, stressMin: -300, source } };
}
function saved(documentId = 'owner') {
  return { schema: FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA, id: 'fatigue-local-cycle', source: { documentId }, input: problem() };
}
const withMaterial = (change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...saved(), input: { ...problem(), material: { ...problem().material, ...change } } });
const withCycle = (change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...saved(), input: { ...problem(), cycle: { ...problem().cycle, ...change } } });
/** Stress-life version 3 (Goodman) exactly as the existing saved format writes it. */
function goodman(documentId = 'owner') {
  return { schema: FATIGUE_SAVED_GOODMAN_SCHEMA, id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [150, 250],
      sequence: 'repeated-periodic', repeats: 1, source }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 1001, source } };
}
/** Zero-mean strain-life histories (fatigue-strain-life/1) exactly as that saved format writes them. */
function strainHistories(documentId = 'owner') {
  return { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material: problem().material,
      histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
        strain: [-0.0078125, 0.0078125], sequence: 'repeated-periodic', repeats: 10, source }] } };
}
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
function issue(value: unknown): readonly [string, string] {
  const checked = readBeamAnalysisInputs(value, 'owner');
  return checked.ok ? ['accepted', ''] : [checked.issue.code, checked.issue.path];
}

describe('saved local-cycle fatigue input', () => {
  it('preserves the input exactly with fresh nested ownership and no calculated results', () => {
    const value = saved(), checked = readFatigueLocalCycleSavedInput(value, 'definition');
    expect(checked).toEqual(value);
    expect(checked.input.cycle).not.toBe(value.input.cycle);
    expect(checked.input.material.calibration).not.toBe(value.input.material.calibration);
    expect(Object.keys(checked).sort()).toEqual(['id', 'input', 'schema', 'source']);
    expect(JSON.stringify(checked)).not.toMatch(/"(?:cyclesToFailure|reversalsToFailure|damage|life|swtParameterMpa|result)"/u);
  });

  it('writes through the same reader and keeps both corrections and domain-limited inputs saveable', () => {
    expect(createFatigueLocalCycleSavedInput('owner', problem())).toEqual(saved());
    const morrow = { ...problem(), correction: 'morrow' };
    expect(createFatigueLocalCycleSavedInput('owner', morrow).input.correction).toBe('morrow');
    // A non-positive SWT maximum stress is refused by the analysis, not by the saved format.
    const compressive = { ...problem(), cycle: { ...problem().cycle, stressMax: -10, stressMin: -500 } };
    expect(createFatigueLocalCycleSavedInput('owner', compressive).input.cycle.stressMax).toBe(-10);
    expect(() => createFatigueLocalCycleSavedInput('owner', { ...problem(), correction: 'none' })).toThrow();
  });

  it('coexists with stress-life v3 and zero-mean strain histories in one document and survives a JSON round trip', () => {
    const value = attachment({ kind: 'fatigue', definition: goodman() }, { kind: 'fatigue-strain-life', definition: strainHistories() },
      { kind: 'fatigue-local-cycle', definition: saved() });
    const checked = readBeamAnalysisInputs(JSON.parse(JSON.stringify(value)), 'owner');
    if (!checked.ok) throw new Error(`${checked.issue.code} at ${checked.issue.path}`);
    expect(checked.value).toEqual(value);
    const again = readBeamAnalysisInputs(JSON.parse(JSON.stringify(checked.value)), 'owner');
    expect(again.ok ? again.value : null).toEqual(checked.value);
  });

  it('allows one local-cycle configuration per document, of this document only', () => {
    const one = { kind: 'fatigue-local-cycle', definition: saved() };
    expect(issue(attachment(one, one))).toEqual(['duplicate-id', 'analyses']);
    expect(issue(attachment({ kind: 'fatigue-local-cycle', definition: saved('other') }))).toEqual(['wrong-document', 'source.documentId']);
  });

  const at = 'analyses[0].definition';
  const { schema, correction, material } = problem(), withoutCycle = { schema, correction, material };
  const invalid: [string, unknown, string, string][] = [
    ['unknown version', { ...saved(), schema: 'pointercad-fatigue-local-cycle-saved/2' }, 'unsupported-model', at],
    ['other kind id', { ...saved(), id: 'fatigue-strain-life' }, 'fatigue-local-cycle', `${at}.id`],
    ['result injection', { ...saved(), result: { cyclesToFailure: 100 } }, 'shape', at],
    ['missing cycle', { ...saved(), input: withoutCycle }, 'shape', `${at}.input`],
    ['unknown correction', { ...saved(), input: { ...problem(), correction: 'goodman' } }, 'fatigue-local-cycle', `${at}.input.correction`],
    ['correction holding undefined', { ...saved(), input: { ...problem(), correction: undefined } }, 'fatigue-local-cycle',
      `${at}.input.correction`],
    ['material grade injection', withMaterial({ grade: 'invented' }), 'shape', `${at}.input.material`],
    ['modulus in GPa', withMaterial({ elasticModulusMpa: 206 }), 'fatigue-local-cycle', `${at}.input.material.elasticModulusMpa`],
    ['calibration reversed', withMaterial({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } }), 'fatigue-local-cycle',
      `${at}.input.material.calibration.maximumCycles`],
    ['calibration holding undefined', withMaterial({ calibration: { minimumCycles: undefined, maximumCycles: 1e6 } }),
      'fatigue-local-cycle', `${at}.input.material.calibration.minimumCycles`],
    ['blank material source', withMaterial({ source: { ...source, reference: ' ' } }), 'fatigue-local-cycle', `${at}.input.material.source`],
    ['elastic stress as strain', withCycle({ strainMeasure: 'elastic-stress-over-modulus' }), 'fatigue-local-cycle',
      `${at}.input.cycle.strainMeasure`],
    ['stress unit', withCycle({ stressUnit: 'Pa' }), 'fatigue-local-cycle', `${at}.input.cycle.stressUnit`],
    ['strain holding undefined', withCycle({ strainMin: undefined }), 'fatigue-local-cycle', `${at}.input.cycle.strainMin`],
    ['nonfinite stress', withCycle({ stressMax: Number.NaN }), 'fatigue-local-cycle', `${at}.input.cycle.stressMax`],
    ['reversed strain extrema', withCycle({ strainMax: -0.01, strainMin: 0.01 }), 'fatigue-local-cycle', `${at}.input.cycle.strainMin`],
    ['equal stress extrema', withCycle({ stressMax: 200, stressMin: 200 }), 'fatigue-local-cycle', `${at}.input.cycle.stressMin`],
    ['cycle source missing', withCycle({ source: undefined }), 'shape', `${at}.input.cycle.source`],
  ];
  it.each(invalid)('refuses %s through the actual document attachment reader', (_label, definition, code, path) => {
    expect(issue(attachment({ kind: 'fatigue-local-cycle', definition }))).toEqual([code, path]);
  });
});
