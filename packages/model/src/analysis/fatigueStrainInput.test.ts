import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './index.js';
import { FATIGUE_STRAIN_SAVED_SCHEMA, createFatigueStrainSavedInput, readFatigueStrainSavedInput } from './fatigueStrainInput.js';
import { FATIGUE_SAVED_GOODMAN_SCHEMA } from './fatigueInput.js';

/** Synthetic values, independent of a material catalogue and of the reader being checked: manufactured coefficients
 * (not SS400, S45C or any real material) and strains that are multiples of 2 ** -8. Every expected code and path
 * below is written out by hand from the saved format, not taken from the reader. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured strain-life coefficients' };
function problem() {
  return { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero',
    material: { id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
      fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
      calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source },
    histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
      strain: [-0.0078125, 0.0078125], sequence: 'repeated-periodic', repeats: 10, source }] };
}
function saved(documentId = 'owner') {
  return { schema: FATIGUE_STRAIN_SAVED_SCHEMA, id: 'fatigue-strain-life', source: { documentId }, input: problem() };
}
const withMaterial = (change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...saved(), input: { ...problem(), material: { ...problem().material, ...change } } });
const withHistory = (change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...saved(), input: { ...problem(), histories: [{ ...problem().histories[0], ...change }] } });
/** Stress-life version 3 with Goodman, as written by the existing saved format (unchanged by this slice). */
function goodman(documentId = 'owner') {
  const curveSource = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'uniaxial elastic test' };
  return { schema: FATIGUE_SAVED_GOODMAN_SCHEMA, id: 'fatigue', source: { documentId }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'amplitude',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2,
      cutoffStressMpa: null, source: curveSource }, histories: [{ id: 'history-1', unit: 'MPa', stressMpa: [150, 250],
      sequence: 'repeated-periodic', repeats: 1, source: curveSource }] },
    correction: { schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
      applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
      minimumCycles: 1001, source: curveSource } };
}
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
function issue(value: unknown): readonly [string, string] {
  const checked = readBeamAnalysisInputs(value, 'owner');
  return checked.ok ? ['accepted', ''] : [checked.issue.code, checked.issue.path];
}

describe('saved strain-life fatigue input', () => {
  it('preserves the input exactly with fresh nested ownership and no calculated results', () => {
    const value = saved(), checked = readFatigueStrainSavedInput(value, 'definition');
    expect(checked).toEqual(value);
    expect(checked.input).not.toBe(value.input);
    expect(checked.input.material.calibration).not.toBe(value.input.material.calibration);
    expect(checked.input.histories[0]?.strain).not.toBe(value.input.histories[0]?.strain);
    expect(Object.keys(checked).sort()).toEqual(['id', 'input', 'schema', 'source']);
    expect(JSON.stringify(checked)).not.toMatch(/"(?:damage|life|result|cycles|cyclesToFailure)"/u);
  });

  it('writes through the same reader, so a written value is exactly what a later read returns', () => {
    const written = createFatigueStrainSavedInput('owner', problem());
    expect(written).toEqual(saved());
    expect(readFatigueStrainSavedInput(JSON.parse(JSON.stringify(written)), 'definition')).toEqual(written);
    expect(() => createFatigueStrainSavedInput('owner', { ...problem(), meanStress: 'morrow' })).toThrow();
  });

  it('coexists with every stress-life saved version in one document and survives a JSON round trip', () => {
    const current = goodman();
    const common = { id: current.id, source: current.source, input: current.input };
    const version2 = { ...common, schema: 'pointercad-fatigue-saved/2', axial: [] };
    for (const [stress, expected] of [[current, current], [version2, version2],
      [{ ...common, schema: 'pointercad-fatigue-saved/1' }, version2]] as const) {
      const value = attachment({ kind: 'fatigue', definition: stress }, { kind: 'fatigue-strain-life', definition: saved() });
      const checked = readBeamAnalysisInputs(JSON.parse(JSON.stringify(value)), 'owner');
      if (!checked.ok) throw new Error(`${checked.issue.code} at ${checked.issue.path}`);
      expect(checked.value.analyses).toEqual([{ kind: 'fatigue', definition: expected },
        { kind: 'fatigue-strain-life', definition: saved() }]);
      const again = readBeamAnalysisInputs(JSON.parse(JSON.stringify(checked.value)), 'owner');
      expect(again.ok ? again.value : null).toEqual(checked.value);
    }
  });

  it('allows one strain-life configuration per document, of this document only', () => {
    const one = { kind: 'fatigue-strain-life', definition: saved() };
    expect(issue(attachment(one, one))).toEqual(['duplicate-id', 'analyses']);
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition: saved('other') })))
      .toEqual(['wrong-document', 'source.documentId']);
  });

  const at = 'analyses[0].definition';
  const { schema, material, histories } = problem(), withoutMeanStress = { schema, material, histories };
  const invalid: [string, unknown, string, string][] = [
    ['unknown version', { ...saved(), schema: 'pointercad-fatigue-strain-saved/2' }, 'unsupported-model', at],
    ['stress-life id', { ...saved(), id: 'fatigue' }, 'fatigue-strain', `${at}.id`],
    ['result injection', { ...saved(), result: { damage: 0 } }, 'shape', at],
    ['Morrow without stress association', { ...saved(), input: { ...problem(), meanStress: 'morrow' } },
      'fatigue-strain', `${at}.input.meanStress`],
    ['missing mean-stress key', { ...saved(), input: withoutMeanStress }, 'shape', `${at}.input`],
    ['mean-stress key holding undefined', { ...saved(), input: { ...problem(), meanStress: undefined } },
      'fatigue-strain', `${at}.input.meanStress`],
    ['material injection', withMaterial({ grade: 'invented' }), 'shape', `${at}.input.material`],
    ['material missing', { ...saved(), input: { ...problem(), material: null } }, 'shape', `${at}.input.material`],
    ['modulus in GPa', withMaterial({ elasticModulusMpa: 206 }), 'fatigue-strain', `${at}.input.material.elasticModulusMpa`],
    ['positive exponent', withMaterial({ fatigueStrengthExponent: 0.1 }), 'fatigue-strain', `${at}.input.material.fatigueStrengthExponent`],
    ['negative zero exponent', withMaterial({ fatigueDuctilityExponent: -0 }), 'fatigue-strain',
      `${at}.input.material.fatigueDuctilityExponent`],
    ['coerced coefficient', withMaterial({ fatigueDuctilityCoefficient: '0.995' }), 'fatigue-strain',
      `${at}.input.material.fatigueDuctilityCoefficient`],
    ['calibration reversed', withMaterial({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } }), 'fatigue-strain',
      `${at}.input.material.calibration.maximumCycles`],
    ['calibration empty', withMaterial({ calibration: { minimumCycles: 10, maximumCycles: 10 } }), 'fatigue-strain',
      `${at}.input.material.calibration.maximumCycles`],
    ['calibration below one reversal', withMaterial({ calibration: { minimumCycles: 0.25, maximumCycles: 1e6 } }),
      'fatigue-strain', `${at}.input.material.calibration.minimumCycles`],
    ['calibration above limit', withMaterial({ calibration: { minimumCycles: 1, maximumCycles: 1e13 } }), 'fatigue-strain',
      `${at}.input.material.calibration.maximumCycles`],
    ['calibration shape', withMaterial({ calibration: { minimumCycles: 1 } }), 'shape', `${at}.input.material.calibration`],
    ['blank material source', withMaterial({ source: { ...source, reference: ' ' } }), 'fatigue-strain', `${at}.input.material.source`],
    ['no history', { ...saved(), input: { ...problem(), histories: [] } }, 'fatigue-strain', `${at}.input.histories`],
    ['sparse histories', { ...saved(), input: { ...problem(), histories: new Array(1) } }, 'fatigue-strain', `${at}.input.histories`],
    ['stress history injected', withHistory({ stressMpa: [150, 250] }), 'shape', `${at}.input.histories[0]`],
    ['elastic stress as strain', withHistory({ strainMeasure: 'elastic-stress-over-modulus' }), 'fatigue-strain',
      `${at}.input.histories[0].strainMeasure`],
    ['linear-elastic derivation', withHistory({ derivation: 'linear-elastic' }), 'fatigue-strain', `${at}.input.histories[0].derivation`],
    ['strain in percent', withHistory({ strainUnit: 'percent' }), 'fatigue-strain', `${at}.input.histories[0].strainUnit`],
    ['sparse strain', withHistory({ strain: new Array(2) }), 'fatigue-strain', `${at}.input.histories[0].strain`],
    ['nonfinite strain', withHistory({ strain: [0, Number.NaN] }), 'fatigue-strain', `${at}.input.histories[0].strain[1]`],
    ['microstrain', withHistory({ strain: [0, 1500] }), 'fatigue-strain', `${at}.input.histories[0].strain[1]`],
    ['once repeated', withHistory({ sequence: 'once', repeats: 2 }), 'fatigue-strain', `${at}.input.histories[0].repeats`],
  ];
  it.each(invalid)('refuses %s through the actual document attachment reader', (_label, definition, code, path) => {
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition }))).toEqual([code, path]);
  });
});
