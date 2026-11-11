import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './index.js';
import { FATIGUE_STRAIN_SAVED_SCHEMA, FATIGUE_STRAIN_STRESS_SAVED_SCHEMA, createFatigueStrainStressSavedInput,
  readFatigueStrainSavedConfiguration, readFatigueStrainSavedInput } from './fatigueStrainInput.js';

/** Synthetic values, independent of a material catalogue and of the reader being checked: manufactured coefficients (not
 * SS400, S45C or any real material), strains that are multiples of 2 ** -8 and stresses typed as a user would. Every
 * expected code and path below is written out by hand from the saved format, not taken from the reader. */
const u = 2 ** -8;
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured strain-life coefficients' };
const material = () => ({ id: 'manufactured', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000,
  fatigueStrengthExponent: -0.5, fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5,
  calibration: { minimumCycles: 1, maximumCycles: 1e6 }, source });
function pairedHistory() {
  return { id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress',
    stressUnit: 'MPa', timeUnit: 'second', derivation: 'elastic-plastic-analysis',
    samples: [{ timeSeconds: 0, strain: -2 * u, stressMpa: -100 }, { timeSeconds: 0.5, strain: 2 * u, stressMpa: 300 }],
    sequence: 'repeated-periodic', repeats: 10, source };
}
function pairedProblem() {
  return { schema: 'pointercad-strain-stress-history/1', meanStress: 'morrow-paired-reversal-stress', material: material(),
    histories: [pairedHistory()] };
}
function pairedSaved(documentId = 'owner') {
  return { schema: 'pointercad-fatigue-strain-stress-saved/1', id: 'fatigue-strain-life', source: { documentId },
    input: pairedProblem() };
}
/** The zero-mean strain-only configuration exactly as saved format 1 writes it (unchanged by this slice). */
function strainProblem() {
  return { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material: material(),
    histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured',
      strain: [-2 * u, 2 * u], sequence: 'repeated-periodic', repeats: 10, source }] };
}
function strainSaved(documentId = 'owner') {
  return { schema: 'pointercad-fatigue-strain-saved/1', id: 'fatigue-strain-life', source: { documentId }, input: strainProblem() };
}
const withHistory = (change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...pairedSaved(), input: { ...pairedProblem(), histories: [{ ...pairedHistory(), ...change }] } });
/** The paired history with its samples replaced by a strain-only list (no `samples` key at all). */
const strainListHistory = (): Record<string, unknown> => ({ ...pairedSaved(), input: { ...pairedProblem(), histories: [{
  ...Object.fromEntries(Object.entries(pairedHistory()).filter(([key]) => key !== 'samples')), strain: [-2 * u, 2 * u] }] } });
const withSample = (index: number, sample: unknown): Record<string, unknown> => {
  const samples: unknown[] = [...pairedHistory().samples];
  samples[index] = sample;
  return withHistory({ samples });
};
const withMaterial = (change: Record<string, unknown>): Record<string, unknown> =>
  ({ ...pairedSaved(), input: { ...pairedProblem(), material: { ...material(), ...change } } });
const attachment = (...analyses: unknown[]) => ({ schema: 'pointercad-beam-inputs/1', analyses });
function issue(value: unknown): readonly [string, string] {
  const checked = readBeamAnalysisInputs(value, 'owner');
  return checked.ok ? ['accepted', ''] : [checked.issue.code, checked.issue.path];
}
function thrown(read: () => unknown): readonly [string, string] {
  try {
    read();
  } catch (error) {
    if (error instanceof Error && 'code' in error && 'path' in error && typeof error.code === 'string'
      && typeof error.path === 'string') return [error.code, error.path];
    throw error;
  }
  return ['accepted', ''];
}

describe('saved paired strain-stress fatigue input', () => {
  it('names its own saved schema and keeps the zero-mean schema 1 unchanged', () => {
    expect([FATIGUE_STRAIN_STRESS_SAVED_SCHEMA, FATIGUE_STRAIN_SAVED_SCHEMA])
      .toEqual(['pointercad-fatigue-strain-stress-saved/1', 'pointercad-fatigue-strain-saved/1']);
  });

  it('keeps every typed sample exactly through the document attachment and a JSON round trip, with fresh ownership', () => {
    const value = attachment({ kind: 'fatigue-strain-life', definition: pairedSaved() });
    const checked = readBeamAnalysisInputs(JSON.parse(JSON.stringify(value)), 'owner');
    if (!checked.ok) throw new Error(`${checked.issue.code} at ${checked.issue.path}`);
    expect(checked.value.analyses).toEqual([{ kind: 'fatigue-strain-life', definition: pairedSaved() }]);
    const again = readBeamAnalysisInputs(JSON.parse(JSON.stringify(checked.value)), 'owner');
    expect(again.ok ? again.value : null).toEqual(checked.value);
    const definition = pairedSaved();
    const direct = readFatigueStrainSavedConfiguration(definition, 'definition');
    expect(direct).toEqual(pairedSaved());
    if (direct.schema !== FATIGUE_STRAIN_STRESS_SAVED_SCHEMA) throw new Error('Read as the zero-mean variant');
    // Fresh nested ownership: a later change of the caller's arrays cannot change the read input.
    expect(direct.input.histories[0]?.samples).not.toBe(definition.input.histories[0]?.samples);
    expect(direct.input.histories[0]?.samples[1]).not.toBe(definition.input.histories[0]?.samples[1]);
    expect(JSON.stringify(direct)).not.toMatch(/"(?:damage|life|result|cycles|cyclesToFailure|meanStressMpa)"/u);
  });

  it('writes through the same reader, so a written value is exactly what a later read returns', () => {
    const written = createFatigueStrainStressSavedInput('owner', pairedProblem());
    expect(written).toEqual(pairedSaved());
    expect(readFatigueStrainSavedConfiguration(JSON.parse(JSON.stringify(written)), 'definition')).toEqual(written);
    // The paired writer never accepts the zero-mean problem, and the problem is never rewritten to fit.
    expect(thrown(() => createFatigueStrainStressSavedInput('owner', strainProblem()))).toEqual(['fatigue-strain', 'definition.input.schema']);
  });

  it('keeps an old zero-mean strain-only document valid with its explicit zero-mean statement', () => {
    const old = readFatigueStrainSavedConfiguration(JSON.parse(JSON.stringify(strainSaved())), 'definition');
    expect(old).toEqual(strainSaved());
    expect([old.schema, old.input.meanStress]).toEqual(['pointercad-fatigue-strain-saved/1', 'assumed-zero']);
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition: strainSaved() }))).toEqual(['accepted', '']);
  });

  it('is refused as an unsupported version by a reader that knows only the zero-mean schema 1', () => {
    expect(thrown(() => readFatigueStrainSavedInput(pairedSaved(), 'definition'))).toEqual(['unsupported-model', 'definition']);
  });

  const at = 'analyses[0].definition';
  const inherited: Record<string, unknown> = Object.create({ schema: 'pointercad-fatigue-strain-stress-saved/1' }) as Record<string, unknown>;
  Object.assign(inherited, { id: 'fatigue-strain-life', source: { documentId: 'owner' }, input: pairedProblem() });
  const variants: [string, unknown, string, string][] = [
    ['paired problem under the zero-mean saved schema', { ...strainSaved(), input: pairedProblem() }, 'fatigue-strain',
      `${at}.input.schema`],
    ['zero-mean problem under the paired saved schema', { ...pairedSaved(), input: strainProblem() }, 'fatigue-strain',
      `${at}.input.schema`],
    ['paired samples declared as zero mean', { ...pairedSaved(), input: { ...pairedProblem(), meanStress: 'assumed-zero' } },
      'fatigue-strain', `${at}.input.meanStress`],
    ['unknown paired version', { ...pairedSaved(), schema: 'pointercad-fatigue-strain-stress-saved/2' }, 'unsupported-model', at],
    ['unknown zero-mean version', { ...strainSaved(), schema: 'pointercad-fatigue-strain-saved/2' }, 'unsupported-model', at],
    ['inherited paired schema', inherited, 'shape', at],
  ];
  it.each(variants)('never reads one variant as the other: %s', (_label, definition, code, path) => {
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition }))).toEqual([code, path]);
  });

  it('allows one strain-life configuration per document, of either variant, of this document only', () => {
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition: strainSaved() },
      { kind: 'fatigue-strain-life', definition: pairedSaved() }))).toEqual(['duplicate-id', 'analyses']);
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition: pairedSaved('other') })))
      .toEqual(['wrong-document', 'source.documentId']);
  });

  const history = `${at}.input.histories[0]`;
  const invalid: [string, unknown, string, string][] = [
    ['result injection', { ...pairedSaved(), result: { damage: 0 } }, 'shape', at],
    ['strain list instead of samples', strainListHistory(), 'shape', history],
    ['separate stress list', withHistory({ stressMpa: [-100, 300] }), 'shape', history],
    ['elastic stress as local stress', withHistory({ stressMeasure: 'elastic-stress' }), 'fatigue-strain', `${history}.stressMeasure`],
    ['stress over modulus as strain', withHistory({ strainMeasure: 'elastic-stress-over-modulus' }), 'fatigue-strain',
      `${history}.strainMeasure`],
    ['linear-elastic derivation', withHistory({ derivation: 'linear-elastic' }), 'fatigue-strain', `${history}.derivation`],
    ['strain in percent', withHistory({ strainUnit: 'percent' }), 'fatigue-strain', `${history}.strainUnit`],
    ['stress in kPa', withHistory({ stressUnit: 'kPa' }), 'fatigue-strain', `${history}.stressUnit`],
    ['time in milliseconds', withHistory({ timeUnit: 'millisecond' }), 'fatigue-strain', `${history}.timeUnit`],
    ['no sample', withHistory({ samples: [] }), 'fatigue-strain', `${history}.samples`],
    ['sparse samples', withHistory({ samples: new Array(2) }), 'fatigue-strain', `${history}.samples`],
    ['sample without stress', withSample(1, { timeSeconds: 0.5, strain: 2 * u }), 'shape', `${history}.samples[1]`],
    ['sample with an extra channel', withSample(1, { timeSeconds: 0.5, strain: 2 * u, stressMpa: 300, temperature: 20 }), 'shape',
      `${history}.samples[1]`],
    ['nonfinite time', withSample(0, { timeSeconds: Number.NaN, strain: -2 * u, stressMpa: -100 }), 'fatigue-strain',
      `${history}.samples[0].timeSeconds`],
    ['coerced strain', withSample(0, { timeSeconds: 0, strain: '-0.0078125', stressMpa: -100 }), 'fatigue-strain',
      `${history}.samples[0].strain`],
    ['nonfinite stress', withSample(1, { timeSeconds: 0.5, strain: 2 * u, stressMpa: Number.POSITIVE_INFINITY }), 'fatigue-strain',
      `${history}.samples[1].stressMpa`],
    ['microstrain', withSample(1, { timeSeconds: 0.5, strain: 1500, stressMpa: 300 }), 'fatigue-strain', `${history}.samples[1].strain`],
    ['stress in Pa', withSample(1, { timeSeconds: 0.5, strain: 2 * u, stressMpa: 300e6 }), 'fatigue-strain',
      `${history}.samples[1].stressMpa`],
    ['repeated time', withSample(1, { timeSeconds: 0, strain: 2 * u, stressMpa: 300 }), 'fatigue-strain',
      `${history}.samples[1].timeSeconds`],
    ['reordered samples', withSample(1, { timeSeconds: -0.5, strain: 2 * u, stressMpa: 300 }), 'fatigue-strain',
      `${history}.samples[1].timeSeconds`],
    ['once repeated', withHistory({ sequence: 'once', repeats: 2 }), 'fatigue-strain', `${history}.repeats`],
    ['blank history source', withHistory({ source: { ...source, reference: ' ' } }), 'fatigue-strain', `${history}.source`],
    ['duplicate history id', { ...pairedSaved(), input: { ...pairedProblem(), histories: [pairedHistory(), pairedHistory()] } },
      'fatigue-strain', `${at}.input.histories[1].id`],
    ['no history', { ...pairedSaved(), input: { ...pairedProblem(), histories: [] } }, 'fatigue-strain', `${at}.input.histories`],
    ['modulus in GPa', withMaterial({ elasticModulusMpa: 206 }), 'fatigue-strain', `${at}.input.material.elasticModulusMpa`],
    ['calibration reversed', withMaterial({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } }), 'fatigue-strain',
      `${at}.input.material.calibration.maximumCycles`],
  ];
  it.each(invalid)('refuses %s through the actual document attachment reader', (_label, definition, code, path) => {
    expect(issue(attachment({ kind: 'fatigue-strain-life', definition }))).toEqual([code, path]);
  });
});
