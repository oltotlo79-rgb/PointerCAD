import { describe, expect, it } from 'vitest';
import { createFatigueStrainStressSavedInput, readFatigueStrainStressSavedProblem } from '@pointercad/model/beam-analysis';
import { analyzeStrainStressHistory, validateStrainStressHistoryInput } from './fatigueStrainStressHistory.js';

/* Reader parity between the saved paired model format and the paired solver input. Every case states its expected
 * verdict by hand ('accepted' or the path of the first refused field, relative to the problem root); both readers must
 * return exactly that verdict, so a drift of either copy (bounds, units, time order, check order, paths) fails here.
 * Coefficients are manufactured test values (not SS400, S45C or any real material); strains are multiples of u = 2 ** -8
 * and the stresses are typed values, never computed from a strain. */
const u = 2 ** -8;
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured strain-life coefficients' };
const material = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured', stressUnit: 'MPa',
  elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration: { minimumCycles: 1, maximumCycles: 1e6 },
  source, ...change });
const sample = (timeSeconds: unknown, strain: unknown, stressMpa: unknown): Record<string, unknown> => ({ timeSeconds, strain, stressMpa });
const SAMPLES = [sample(0, -2 * u, -100), sample(0.5, 2 * u, 300)];
const history = (change: Record<string, unknown> = {}, id = 'h1'): Record<string, unknown> => ({ id,
  strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress', stressUnit: 'MPa',
  timeUnit: 'second', derivation: 'measured', samples: SAMPLES, sequence: 'repeated-periodic', repeats: 10, source, ...change });
const problem = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: 'pointercad-strain-stress-history/1',
  meanStress: 'morrow-paired-reversal-stress', material: material(), histories: [history()], ...change });
const withSamples = (samples: unknown): Record<string, unknown> => problem({ histories: [history({ samples })] });

function modelVerdict(value: unknown): string {
  try {
    readFatigueStrainStressSavedProblem(value, 'input');
    return 'accepted';
  } catch (error) {
    if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string') throw error;
    const path = error.path.replace(/^input\.?/u, '');
    return path === '' ? '$' : path;
  }
}
function solverVerdict(value: unknown): string {
  const checked = validateStrainStressHistoryInput(value);
  return checked.ok ? 'accepted' : checked.path;
}

describe('saved paired strain-stress problem and paired solver input readers agree', () => {
  const tooMany = Array.from({ length: 65 }, (_, index) => history({}, `h${index}`));
  const longSamples = Array.from({ length: 100_001 }, (_, index) => sample(index, 0, 0));
  const cases: [string, unknown, string][] = [
    ['valid', problem(), 'accepted'],
    ['elastic-plastic analysis', problem({ histories: [history({ derivation: 'elastic-plastic-analysis' })] }), 'accepted'],
    ['one sample', withSamples([sample(0, 0, 0)]), 'accepted'],
    ['stress and strain at their limits', withSamples([sample(-1, -1, -1e4), sample(1e-9, 1, 1e4)]), 'accepted'],
    ['100000 samples', withSamples(longSamples.slice(0, 100_000)), 'accepted'],
    ['64 histories', problem({ histories: tooMany.slice(0, 64) }), 'accepted'],
    ['not a record', null, '$'],
    ['extra key', { ...problem(), damage: 0 }, '$'],
    ['zero-mean schema', problem({ schema: 'pointercad-strain-history/1' }), 'schema'],
    ['assumed zero mean stress', problem({ meanStress: 'assumed-zero' }), 'meanStress'],
    ['plain Morrow', problem({ meanStress: 'morrow' }), 'meanStress'],
    ['material injection', problem({ material: material({ grade: 'invented' }) }), 'material'],
    ['modulus in GPa', problem({ material: material({ elasticModulusMpa: 206 }) }), 'material.elasticModulusMpa'],
    ['calibration reversed', problem({ material: material({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } }) }),
      'material.calibration.maximumCycles'],
    ['material source blank', problem({ material: material({ source: { ...source, reference: ' ' } }) }), 'material.source'],
    ['no history', problem({ histories: [] }), 'histories'],
    ['sparse histories', problem({ histories: new Array(1) }), 'histories'],
    ['65 histories', problem({ histories: tooMany }), 'histories'],
    ['strain-only history', problem({ histories: [{ ...history(), samples: undefined, strain: [-2 * u, 2 * u] }] }), 'histories[0]'],
    ['separate stress list', problem({ histories: [history({ stressMpa: [-100, 300] })] }), 'histories[0]'],
    ['blank id', problem({ histories: [history({ id: ' ' })] }), 'histories[0].id'],
    ['elastic stress over modulus as strain', problem({ histories: [history({ strainMeasure: 'elastic-stress-over-modulus' })] }),
      'histories[0].strainMeasure'],
    ['elastic stress as local stress', problem({ histories: [history({ stressMeasure: 'elastic-stress' })] }),
      'histories[0].stressMeasure'],
    ['linear-elastic derivation', problem({ histories: [history({ derivation: 'linear-elastic' })] }), 'histories[0].derivation'],
    ['strain in percent', problem({ histories: [history({ strainUnit: 'percent' })] }), 'histories[0].strainUnit'],
    ['stress in kPa', problem({ histories: [history({ stressUnit: 'kPa' })] }), 'histories[0].stressUnit'],
    ['time in milliseconds', problem({ histories: [history({ timeUnit: 'millisecond' })] }), 'histories[0].timeUnit'],
    ['no sample', withSamples([]), 'histories[0].samples'],
    ['sparse samples', withSamples(new Array(2)), 'histories[0].samples'],
    ['100001 samples', withSamples(longSamples), 'histories[0].samples'],
    ['sample not a record', withSamples([SAMPLES[0], [0.5, 2 * u, 300]]), 'histories[0].samples[1]'],
    ['sample without stress', withSamples([SAMPLES[0], { timeSeconds: 0.5, strain: 2 * u }]), 'histories[0].samples[1]'],
    ['nonfinite time', withSamples([sample(Number.NaN, 0, 0)]), 'histories[0].samples[0].timeSeconds'],
    ['coerced strain', withSamples([sample(0, '0', 0)]), 'histories[0].samples[0].strain'],
    ['nonfinite stress', withSamples([sample(0, 0, Number.NEGATIVE_INFINITY)]), 'histories[0].samples[0].stressMpa'],
    // A nonfinite stress is reported before an out-of-bound strain of the same sample (the readers' order).
    ['stress number before strain bound', withSamples([sample(0, 2, Number.NaN)]), 'histories[0].samples[0].stressMpa'],
    ['strain beyond 1', withSamples([sample(0, -1.000000001, 0)]), 'histories[0].samples[0].strain'],
    ['stress beyond 10000 MPa', withSamples([sample(0, 0, 10_000.000001)]), 'histories[0].samples[0].stressMpa'],
    ['stress bound before time order', withSamples([sample(1, 0, 0), sample(0, 0, 2e4)]), 'histories[0].samples[1].stressMpa'],
    ['repeated time', withSamples([sample(0, 0, 0), sample(0, 2 * u, 300)]), 'histories[0].samples[1].timeSeconds'],
    ['reordered time', withSamples([sample(0, 0, 0), sample(1, 2 * u, 300), sample(0.5, 0, 0)]), 'histories[0].samples[2].timeSeconds'],
    ['sequence', problem({ histories: [history({ sequence: 'twice' })] }), 'histories[0].sequence'],
    ['once repeated', problem({ histories: [history({ sequence: 'once', repeats: 2 })] }), 'histories[0].repeats'],
    ['too many repeats', problem({ histories: [history({ repeats: 1e9 + 1 })] }), 'histories[0].repeats'],
    ['history source missing', problem({ histories: [{ ...history(), source: undefined }] }), 'histories[0].source'],
    ['duplicate history id', problem({ histories: [history(), history()] }), 'histories[1].id'],
  ];
  it.each(cases)('%s', (_label, value, expected) => {
    expect([modelVerdict(value), solverVerdict(value)]).toEqual([expected, expected]);
  });

  it('analyses a saved paired problem directly with the closed-form Morrow damage of its paired mean stress', () => {
    // b = c = -0.5: with Morrow, eps_a = ((sf' - sm) / E + ef') (2N) ** -0.5. The reversal stresses -100 and 300 MPa give
    // sm = 100 MPa, so (1000 - 100) / 200000 + 0.995 = 0.9995 and amplitude 2u = 1 / 128 lives N = 8192 * 0.9995 ** 2;
    // 10 periods of one full cycle (or two half cycles) damage 10 / N.
    const saved = createFatigueStrainStressSavedInput('owner', problem());
    const analysis = analyzeStrainStressHistory(JSON.parse(JSON.stringify(saved.input)));
    if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
    const expected = 10 / (8192 * 0.9995 ** 2);
    expect(Math.abs(analysis.result.damage - expected)).toBeLessThanOrEqual(1e-9 * expected);
    expect(analysis.result.meanStress).toBe('morrow-paired-reversal-stress');
    expect(analysis.result.histories[0]?.cycles.map(cycle => cycle.meanStressMpa)).toEqual(
      analysis.result.histories[0]?.cycles.map(() => 100));
  });

  it('accepts a saved plateau with two stresses but the analysis refuses it at the ambiguous sample', () => {
    // The strain plateau at samples 1 and 2 carries 300 and 250 MPa: no single stress at that reversal.
    const once = problem({ histories: [history({ samples: [sample(0, -2 * u, -100), sample(1, 2 * u, 300), sample(2, 2 * u, 250)],
      sequence: 'once', repeats: 1 })] });
    expect([modelVerdict(once), solverVerdict(once)]).toEqual(['accepted', 'accepted']);
    const analysis = analyzeStrainStressHistory(createFatigueStrainStressSavedInput('owner', once).input);
    expect(analysis.ok ? null : [analysis.code, analysis.path])
      .toEqual(['strain-stress-history-ambiguous-reversal-stress', 'histories[0].samples[2].stressMpa']);
  });
});
