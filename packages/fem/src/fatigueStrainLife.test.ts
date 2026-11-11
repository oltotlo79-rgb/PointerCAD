import { describe, expect, it } from 'vitest';
import { STRAIN_LIFE_LOG_TOLERANCE, STRAIN_LIFE_MAX_ITERATIONS, analyzeStrainLife, strainLifeAmplitudeAt,
  validateStrainLifeInput, type StrainLifeErrorCode, type StrainLifeInput, type StrainLifeResult } from './fatigueStrainLife.js';

/* Manufactured, test-only coefficients: not SS400, S45C or any real material. Every expected life is derived here from
 * a closed form or from the relation written out in this file with Math.pow, never from the production solver:
 *  - b == c: eps_a = (A + B) (2N) ** b, so 2N = (eps_a / (A + B)) ** (1 / b), with A = (sf' - sm) / E and B = ef';
 *  - transition: the elastic and plastic terms are equal at 2N_t = (ef' E / (sf' - sm)) ** (1 / (b - c)).
 * N is cycles and 2N reversals throughout; a solver that used N in place of 2N would report twice these lives. */
const source = { kind: 'user-supplied', reference: 'Test-only manufactured coefficients; not a material value',
  condition: 'Hand-derived example' } as const;
/** b == c == -0.5 and A + B = 1000 / 200000 + 0.995 = 1 at zero mean stress. */
const material = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured',
  stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration: { minimumCycles: 1, maximumCycles: 1e6 },
  source, ...overrides });
/** b = -0.1, c = -0.6, A = 0.005, B = 0.5: transition at 2N_t = (0.5 / 0.005) ** (1 / 0.5) = 1e4 reversals. */
const transitionMaterial = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  material({ fatigueStrengthExponent: -0.1, fatigueDuctilityCoefficient: 0.5, fatigueDuctilityExponent: -0.6, ...overrides });
const loading = (strainAmplitude: unknown, meanStressMpa: unknown = 0, overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ strainMeasure: 'local-total-strain-amplitude', strainUnit: 'dimensionless', derivation: 'measured', strainAmplitude,
    meanStressMpa, source, ...overrides });
const input = (load: Record<string, unknown>, mat: Record<string, unknown> = material(), meanStressCorrection: unknown = 'none'):
  Record<string, unknown> => ({ schema: 'pointercad-strain-life/1', meanStressCorrection, material: mat, loading: load });
function life(value: unknown): StrainLifeResult {
  const analysis = analyzeStrainLife(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
function validated(value: unknown): StrainLifeInput {
  const checked = validateStrainLifeInput(value);
  if (!checked.ok) throw new Error(`${checked.code} at ${checked.path}`);
  return checked.input;
}
const refusal = (value: unknown): readonly [string, string] => {
  const analysis = analyzeStrainLife(value);
  return analysis.ok ? ['accepted', ''] : [analysis.code, analysis.path];
};
const near = (actual: number, expected: number, relative: number): void => {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relative * Math.abs(expected));
};

describe('strain-life closed forms (independent of the solver)', () => {
  it('solves b == c in reversals: eps_a 0.01 on A + B = 1, b = -0.5 gives 2N = 1e4, N = 5000 cycles', () => {
    const result = life(input(loading(0.01)));
    near(result.cyclesToFailure, 5000, 1e-10);
    expect(result.reversalsToFailure).toBe(2 * result.cyclesToFailure);
    near(result.damagePerCycle, 1 / 5000, 1e-10);
  });
  it('solves b == c == -0.25: eps_a 0.2 gives 2N = 0.2 ** -4 = 625, N = 312.5 cycles', () => {
    const result = life(input(loading(0.2), material({ fatigueStrengthExponent: -0.25, fatigueDuctilityExponent: -0.25 })));
    near(result.cyclesToFailure, 312.5, 1e-10);
    near(result.reversalsToFailure, 625, 1e-10);
  });
  it('finds the transition life where the elastic and plastic terms are equal (b != c)', () => {
    // At 2N = 1e4: 0.005 * 1e4 ** -0.1 = 0.005 * 10 ** -0.4 and 0.5 * 1e4 ** -0.6 = 0.5 * 10 ** -2.4, the same value.
    const part = 0.005 * 10 ** -0.4;
    const result = life(input(loading(2 * part), transitionMaterial()));
    near(result.cyclesToFailure, 5000, 1e-10);
    near(result.curveElasticStrainAmplitude, part, 1e-10);
    near(result.curvePlasticStrainAmplitude, part, 1e-10);
  });
  it.each([1.5, 37, 5000, 2.5e5])('returns %s cycles for the amplitude the relation gives at 2N (b != c)', cycles => {
    const reversals = 2 * cycles;
    const amplitude = 1000 / 200_000 * reversals ** -0.1 + 0.5 * reversals ** -0.6;
    const result = life(input(loading(amplitude), transitionMaterial()));
    near(result.cyclesToFailure, cycles, 1e-9);
    expect(Math.abs(result.solver.relativeResidual)).toBeLessThanOrEqual(1e-11);
  });
  it('gives a strictly shorter life for every larger amplitude', () => {
    const lives = [0.004, 0.006, 0.01, 0.02, 0.05].map(amplitude => life(input(loading(amplitude), transitionMaterial())).cyclesToFailure);
    for (let at = 1; at < lives.length; at += 1) expect(lives[at]).toBeLessThan(lives[at - 1]);
  });
});

describe('Morrow mean-stress correction', () => {
  it('shortens the life for a tensile mean and lengthens it for a compressive mean (elastic term only)', () => {
    // +200 MPa: A + B = 800 / 200000 + 0.995 = 0.999, 2N = (0.999 / 0.01) ** 2 = 9980.01, N = 4990.005.
    // -200 MPa: A + B = 1200 / 200000 + 0.995 = 1.001, 2N = (1.001 / 0.01) ** 2 = 10020.01, N = 5010.005.
    const tensile = life(input(loading(0.01, 200), material(), 'morrow'));
    const zero = life(input(loading(0.01, 0), material(), 'morrow'));
    const compressive = life(input(loading(0.01, -200), material(), 'morrow'));
    near(tensile.cyclesToFailure, 4990.005, 1e-10);
    near(zero.cyclesToFailure, 5000, 1e-10);
    near(compressive.cyclesToFailure, 5010.005, 1e-10);
    expect(tensile.cyclesToFailure).toBeLessThan(zero.cyclesToFailure);
    expect(compressive.cyclesToFailure).toBeGreaterThan(zero.cyclesToFailure);
    expect([tensile.method, tensile.meanStressCorrection, tensile.meanStressMpa])
      .toEqual(['basquin-coffin-manson/1+morrow-elastic-term/1', 'morrow', 200]);
  });
  it('reduces to the uncorrected curve at zero mean stress', () => {
    const none = life(input(loading(0.01)));
    expect(none.method).toBe('basquin-coffin-manson/1');
    expect(life(input(loading(0.01), material(), 'morrow')).cyclesToFailure).toBe(none.cyclesToFailure);
  });
  it('refuses a mean stress at or above sigma_f\' and accepts one just below it', () => {
    expect(refusal(input(loading(0.01, 1000), material(), 'morrow'))).toEqual(['strain-life-morrow-domain', 'loading.meanStressMpa']);
    expect(refusal(input(loading(0.01, 1200), material(), 'morrow'))).toEqual(['strain-life-morrow-domain', 'loading.meanStressMpa']);
    const mean = 1000 - 1e-9;
    const expected = (0.01 / ((1000 - mean) / 200_000 + 0.995)) ** (1 / -0.5) / 2;
    near(life(input(loading(0.01, mean), material(), 'morrow')).cyclesToFailure, expected, 1e-10);
  });
  it('refuses a nonzero mean stress without a correction instead of ignoring it', () => {
    expect(refusal(input(loading(0.01, 200)))).toEqual(['strain-life-mean', 'loading.meanStressMpa']);
    expect(refusal(input(loading(0.01, -200)))).toEqual(['strain-life-mean', 'loading.meanStressMpa']);
  });
});

describe('calibrated life interval (no extrapolation)', () => {
  // b == c == -0.5, A + B = 1 on [50, 5000] cycles: the curve is 0.1 at 2N = 100 and 0.01 at 2N = 1e4.
  const calibrated = material({ calibration: { minimumCycles: 50, maximumCycles: 5000 } });
  it('includes both endpoints exactly', () => {
    const curve = validated(input(loading(0.05), calibrated));
    const atShortest = strainLifeAmplitudeAt(curve, 100), atLongest = strainLifeAmplitudeAt(curve, 1e4);
    if (atShortest === null || atLongest === null) throw new Error('calibrated endpoints must be evaluable');
    near(atShortest, 0.1, 1e-12);
    near(atLongest, 0.01, 1e-12);
    const shortest = life(input(loading(atShortest), calibrated)), longest = life(input(loading(atLongest), calibrated));
    expect([shortest.cyclesToFailure, shortest.solver.iterations]).toEqual([50, 0]);
    expect([longest.cyclesToFailure, longest.solver.iterations]).toEqual([5000, 0]);
  });
  it('solves just inside both ends and refuses just outside them', () => {
    const inside = life(input(loading(0.1 * (1 - 1e-9)), calibrated));
    expect(inside.cyclesToFailure).toBeGreaterThan(50);
    near(inside.cyclesToFailure, 50 / (1 - 1e-9) ** 2, 1e-10);
    const insideLong = life(input(loading(0.01 * (1 + 1e-9)), calibrated));
    expect(insideLong.cyclesToFailure).toBeLessThan(5000);
    near(insideLong.cyclesToFailure, 5000 / (1 + 1e-9) ** 2, 1e-10);
    expect(refusal(input(loading(0.1 * (1 + 1e-9)), calibrated)))
      .toEqual(['strain-life-shorter-than-calibration', 'loading.strainAmplitude']);
    expect(refusal(input(loading(0.01 * (1 - 1e-9)), calibrated)))
      .toEqual(['strain-life-longer-than-calibration', 'loading.strainAmplitude']);
  });
  it('does not evaluate the curve outside the interval', () => {
    const curve = validated(input(loading(0.05), calibrated));
    for (const reversals of [99.99, 10_000.01, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(strainLifeAmplitudeAt(curve, reversals)).toBeNull();
    }
  });
  it('never turns a tiny or zero amplitude into an infinite or verified life', () => {
    expect(refusal(input(loading(Number.MIN_VALUE)))).toEqual(['strain-life-longer-than-calibration', 'loading.strainAmplitude']);
    expect(refusal(input(loading(0)))).toEqual(['strain-life-zero-amplitude', 'loading.strainAmplitude']);
    expect(refusal(input(loading(-0)))).toEqual(['strain-life-zero-amplitude', 'loading.strainAmplitude']);
    expect(refusal(input(loading(1e300)))).toEqual(['strain-life-shorter-than-calibration', 'loading.strainAmplitude']);
  });
});

describe('numerical range at the input limits', () => {
  it('stays finite with the smallest coefficients and steepest exponents (no underflow to zero)', () => {
    const smallest = material({ elasticModulusMpa: 1e7, fatigueStrengthCoefficientMpa: 1, fatigueStrengthExponent: -2,
      fatigueDuctilityCoefficient: 1e-6, fatigueDuctilityExponent: -2, calibration: { minimumCycles: 0.5, maximumCycles: 1e12 } });
    const expected = (1e-20 / (1 / 1e7 + 1e-6)) ** (1 / -2) / 2;
    near(life(input(loading(1e-20), smallest)).cyclesToFailure, expected, 1e-10);
    expect(refusal(input(loading(Number.MIN_VALUE), smallest))).toEqual(['strain-life-longer-than-calibration', 'loading.strainAmplitude']);
  });
  it('stays finite with the largest coefficients and a Morrow compressive mean at the stress limit', () => {
    // A = (1e4 + 1e4) / 1e3 = 20, B = 10: the curve is exactly 30 at one reversal.
    const largest = material({ elasticModulusMpa: 1e3, fatigueStrengthCoefficientMpa: 1e4, fatigueStrengthExponent: -2,
      fatigueDuctilityCoefficient: 10, fatigueDuctilityExponent: -2, calibration: { minimumCycles: 0.5, maximumCycles: 1e12 } });
    near(life(input(loading(29, -1e4), largest, 'morrow')).cyclesToFailure, (29 / 30) ** (1 / -2) / 2, 1e-10);
    expect(life(input(loading(30, -1e4), largest, 'morrow')).cyclesToFailure).toBe(0.5);
    expect(refusal(input(loading(30.000001, -1e4), largest, 'morrow')))
      .toEqual(['strain-life-shorter-than-calibration', 'loading.strainAmplitude']);
  });
});

describe('result contract', () => {
  it('reports a bounded bisection, the input echo and no certification, and serializes without loss', () => {
    const result = life(input(loading(0.01), transitionMaterial()));
    expect(result).toMatchObject({ schema: 'pointercad-strain-life-result/1',
      scope: 'uniaxial-constant-amplitude-local-strain-life-estimate', codeCompliance: false, structuralCertification: false,
      materialId: 'manufactured', meanStressCorrection: 'none', strainAmplitude: 0.01, meanStressMpa: 0,
      calibration: { minimumCycles: 1, maximumCycles: 1e6 } });
    expect(result.solver.method).toBe('bisection-log-reversals/1');
    expect(result.solver.iterations).toBeGreaterThan(0);
    expect(result.solver.iterations).toBeLessThanOrEqual(STRAIN_LIFE_MAX_ITERATIONS);
    expect(result.solver.logReversalsHalfWidth).toBeLessThanOrEqual(STRAIN_LIFE_LOG_TOLERANCE);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('copies the input so later caller mutation cannot change a validated value', () => {
    const calibration = { minimumCycles: 1, maximumCycles: 1e6 };
    const checked = validated(input(loading(0.01), material({ calibration })));
    calibration.maximumCycles = 10;
    expect(checked.material.calibration.maximumCycles).toBe(1e6);
  });
});

describe('malformed input (typed refusals, never a thrown error)', () => {
  const cases: [string, unknown, StrainLifeErrorCode, string][] = [
    ['null', null, 'strain-life-shape', '$'],
    ['array', [], 'strain-life-shape', '$'],
    ['missing correction', { schema: 'pointercad-strain-life/1', material: material(), loading: loading(0.01) }, 'strain-life-shape', '$'],
    ['schema', { ...input(loading(0.01)), schema: 'pointercad-strain-life/2' }, 'strain-life-schema', 'schema'],
    ['correction', input(loading(0.01), material(), 'goodman'), 'strain-life-correction', 'meanStressCorrection'],
    ['extra material key', input(loading(0.01), { ...material(), ultimateStrengthMpa: 400 }), 'strain-life-shape', 'material'],
    ['material id', input(loading(0.01), material({ id: '' })), 'strain-life-id', 'material.id'],
    ['stress unit', input(loading(0.01), material({ stressUnit: 'GPa' })), 'strain-life-unit', 'material.stressUnit'],
    ['E NaN', input(loading(0.01), material({ elasticModulusMpa: Number.NaN })), 'strain-life-number', 'material.elasticModulusMpa'],
    ['E infinite', input(loading(0.01), material({ elasticModulusMpa: Number.POSITIVE_INFINITY })), 'strain-life-number', 'material.elasticModulusMpa'],
    ['E text', input(loading(0.01), material({ elasticModulusMpa: '200000' })), 'strain-life-number', 'material.elasticModulusMpa'],
    ['E negative', input(loading(0.01), material({ elasticModulusMpa: -200_000 })), 'strain-life-sign', 'material.elasticModulusMpa'],
    ['E zero', input(loading(0.01), material({ elasticModulusMpa: 0 })), 'strain-life-sign', 'material.elasticModulusMpa'],
    ['E in GPa', input(loading(0.01), material({ elasticModulusMpa: 206 })), 'strain-life-bound', 'material.elasticModulusMpa'],
    ['E in Pa', input(loading(0.01), material({ elasticModulusMpa: 2.06e11 })), 'strain-life-bound', 'material.elasticModulusMpa'],
    ['sigma_f\' too large', input(loading(0.01), material({ fatigueStrengthCoefficientMpa: 2e4 })), 'strain-life-bound', 'material.fatigueStrengthCoefficientMpa'],
    ['sigma_f\' negative', input(loading(0.01), material({ fatigueStrengthCoefficientMpa: -1000 })), 'strain-life-sign', 'material.fatigueStrengthCoefficientMpa'],
    ['b positive', input(loading(0.01), material({ fatigueStrengthExponent: 0.1 })), 'strain-life-sign', 'material.fatigueStrengthExponent'],
    ['b zero', input(loading(0.01), material({ fatigueStrengthExponent: 0 })), 'strain-life-sign', 'material.fatigueStrengthExponent'],
    ['b negative zero', input(loading(0.01), material({ fatigueStrengthExponent: -0 })), 'strain-life-sign', 'material.fatigueStrengthExponent'],
    ['b too steep', input(loading(0.01), material({ fatigueStrengthExponent: -3 })), 'strain-life-bound', 'material.fatigueStrengthExponent'],
    ['c too flat', input(loading(0.01), material({ fatigueDuctilityExponent: -1e-4 })), 'strain-life-bound', 'material.fatigueDuctilityExponent'],
    ['eps_f\' negative', input(loading(0.01), material({ fatigueDuctilityCoefficient: -0.5 })), 'strain-life-sign', 'material.fatigueDuctilityCoefficient'],
    ['eps_f\' too large', input(loading(0.01), material({ fatigueDuctilityCoefficient: 11 })), 'strain-life-bound', 'material.fatigueDuctilityCoefficient'],
    ['calibration reversed', input(loading(0.01), material({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } })),
      'strain-life-calibration', 'material.calibration.maximumCycles'],
    ['calibration empty', input(loading(0.01), material({ calibration: { minimumCycles: 10, maximumCycles: 10 } })),
      'strain-life-calibration', 'material.calibration.maximumCycles'],
    ['calibration below one reversal', input(loading(0.01), material({ calibration: { minimumCycles: 0.25, maximumCycles: 1e6 } })),
      'strain-life-bound', 'material.calibration.minimumCycles'],
    ['calibration zero', input(loading(0.01), material({ calibration: { minimumCycles: 0, maximumCycles: 1e6 } })),
      'strain-life-sign', 'material.calibration.minimumCycles'],
    ['calibration above limit', input(loading(0.01), material({ calibration: { minimumCycles: 1, maximumCycles: 1e13 } })),
      'strain-life-bound', 'material.calibration.maximumCycles'],
    ['calibration shape', input(loading(0.01), material({ calibration: { minimumCycles: 1 } })), 'strain-life-shape', 'material.calibration'],
    ['material source blank', input(loading(0.01), material({ source: { ...source, reference: ' ' } })), 'strain-life-source', 'material.source'],
    ['material source kind', input(loading(0.01), material({ source: { ...source, kind: 'built-in' } })), 'strain-life-source', 'material.source'],
    ['elastic stress as strain', input(loading(0.01, 0, { strainMeasure: 'elastic-equivalent-stress-over-modulus' })),
      'strain-life-strain-measure', 'loading.strainMeasure'],
    ['linear-elastic derivation', input(loading(0.01, 0, { derivation: 'linear-elastic' })), 'strain-life-strain-measure', 'loading.derivation'],
    ['strain in percent', input(loading(0.01, 0, { strainUnit: 'percent' })), 'strain-life-unit', 'loading.strainUnit'],
    ['amplitude NaN', input(loading(Number.NaN)), 'strain-life-number', 'loading.strainAmplitude'],
    ['amplitude text', input(loading('0.01')), 'strain-life-number', 'loading.strainAmplitude'],
    ['amplitude negative', input(loading(-0.01)), 'strain-life-sign', 'loading.strainAmplitude'],
    ['mean infinite', input(loading(0.01, Number.NEGATIVE_INFINITY), material(), 'morrow'), 'strain-life-number', 'loading.meanStressMpa'],
    ['mean beyond stress limit', input(loading(0.01, -2e4), material(), 'morrow'), 'strain-life-bound', 'loading.meanStressMpa'],
    ['loading without source', input({ strainMeasure: 'local-total-strain-amplitude', strainUnit: 'dimensionless',
      derivation: 'measured', strainAmplitude: 0.01, meanStressMpa: 0 }), 'strain-life-shape', 'loading'],
  ];
  it.each(cases)('%s', (_name, value, code, path) => {
    expect(refusal(value)).toEqual([code, path]);
    const checked = validateStrainLifeInput(value);
    expect(checked.ok ? ['accepted', ''] : [checked.code, checked.path]).toEqual([code, path]);
  });
});

/* One published SS400 series (the only real-material numbers in this file; everything above is manufactured):
 * Saeki, Sugisawa, Yamaguchi, Mochizuki, Wada, J. Struct. Constr. Eng. (Trans. AIJ) No. 472, pp. 139-147 (1995),
 * eq. (9) on p. 144: SS400 (comparison steel), axial strain control, R = -1, strain rate 0.1 %/s,
 *   eps_t = 35 Nf^-0.47 + 0.74 Nf^-0.11
 * with eps_t the TOTAL STRAIN RANGE in PERCENT and Nf the CYCLES to failure (load down to 75 % of its maximum, p. 141).
 * Converted here, not printed: amplitude eps_a = eps_t / 200, cycles N -> reversals 2N, so
 *   eps_f' = 0.175 * 2^0.47, c = -0.47 and sigma_f' / E = 0.0037 * 2^0.11, b = -0.11.
 * The paper prints neither E nor sigma_f' (only their ratio) and no test temperature. With zero mean stress only the
 * ratio enters the life, so E below is a scale factor chosen far from any steel modulus (1e4 and 1e6 MPa), never a
 * material value; nothing here is a verified or guaranteed property. The calibration interval is the life of the
 * printed relation at the printed tested ranges 2.0 % and 0.3 % (Table 2), formula-derived, not test lives.
 * Expected lives: owner oracle48.py, which solves the printed relation in cycles directly (floats and 50-digit
 * Decimal, max relative difference 1.8e-15), independent of this solver. */
describe('published SS400 strain-life series (Saeki et al. 1995, eq. (9)), converted to the solver convention', () => {
  const series = { kind: 'user-supplied',
    reference: 'Saeki, Sugisawa, Yamaguchi, Mochizuki, Wada, J. Struct. Constr. Eng. AIJ No.472 (1995) 139-147, eq.(9)',
    condition: 'SS400 (delivery form and heat treatment not stated), axial total-strain control, R=-1, 0.1 %/s, '
      + 'smooth d=10 mm; test temperature not stated; E and sigma_f\' not printed (ratio only)' } as const;
  const ratio = 0.0037 * 2 ** 0.11, ductility = 0.175 * 2 ** 0.47;
  const calibration = { minimumCycles: 674.455474912976, maximumCycles: 217447.85693462685 };
  const ss400 = (scaleMpa: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'ss400-saeki-1995-eq9', stressUnit: 'MPa', elasticModulusMpa: scaleMpa,
    fatigueStrengthCoefficientMpa: scaleMpa * ratio, fatigueStrengthExponent: -0.11,
    fatigueDuctilityCoefficient: ductility, fatigueDuctilityExponent: -0.47, calibration, source: series, ...overrides });
  const at = (amplitude: number, mat: Record<string, unknown> = ss400(1e6)): Record<string, unknown> =>
    input(loading(amplitude, 0, { source: series }), mat);
  /** [printed tested range %, amplitude, cycles from oracle48.py] */
  const known: [number, number, number][] = [
    [1.5, 0.0075, 1390.5233741512593], [1.0, 0.005, 4076.511382674379], [0.5, 0.0025, 32749.869458548637]];

  it.each(known)('range %s %% (amplitude %s) gives %s cycles, as the printed relation solved in cycles', (_range, amplitude, cycles) => {
    const result = life(at(amplitude));
    near(result.cyclesToFailure, cycles, 1e-6);
    expect(result.reversalsToFailure).toBe(2 * result.cyclesToFailure);
    // The two fitted parts are the printed terms halved for the amplitude, evaluated at Nf in cycles.
    near(result.curvePlasticStrainAmplitude, 35 / 200 * cycles ** -0.47, 1e-6);
    near(result.curveElasticStrainAmplitude, 0.74 / 200 * cycles ** -0.11, 1e-6);
  });
  it('does not depend on the unprinted E at zero mean stress (two non-material scales give the same life)', () => {
    const low = life(at(0.005, ss400(1e4))), high = life(at(0.005, ss400(1e6)));
    near(low.cyclesToFailure, high.cyclesToFailure, 1e-10);
    near(low.cyclesToFailure, 4076.511382674379, 1e-6);
  });
  it('rejects the cycles/reversals mix-up: the printed per-cycle coefficients used as per-reversal halve every life', () => {
    const unconverted = ss400(1e6, { fatigueStrengthCoefficientMpa: 1e6 * 0.0037, fatigueDuctilityCoefficient: 0.175 });
    for (const [, amplitude, cycles] of known) {
      const wrong = life(at(amplitude, unconverted)).cyclesToFailure;
      near(wrong / cycles, 0.5, 1e-6);
      expect(Math.abs(life(at(amplitude)).cyclesToFailure - wrong)).toBeGreaterThan(0.49 * cycles);
    }
  });
  it('rejects the range/amplitude mix-up: a 0.5 % range entered as amplitude 0.005 is the life of a 1.0 % range', () => {
    const asRange = life(at(0.005)).cyclesToFailure;
    near(asRange, 4076.511382674379, 1e-6);
    expect(asRange / 32749.869458548637).toBeLessThan(0.13);
  });
  it('refuses the printed percent-of-range coefficient and a percent amplitude instead of reading them as strain', () => {
    expect(refusal(at(0.005, ss400(1e6, { fatigueDuctilityCoefficient: 35 }))))
      .toEqual(['strain-life-bound', 'material.fatigueDuctilityCoefficient']);
    expect(refusal(at(0.5))).toEqual(['strain-life-shorter-than-calibration', 'loading.strainAmplitude']);
  });
  it('refuses lives outside the printed tested ranges (no extrapolation) and keeps the citation', () => {
    expect(refusal(at(0.015))).toEqual(['strain-life-shorter-than-calibration', 'loading.strainAmplitude']);
    expect(refusal(at(0.001))).toEqual(['strain-life-longer-than-calibration', 'loading.strainAmplitude']);
    const result = life(at(0.0025));
    expect([result.materialId, result.codeCompliance, result.structuralCertification])
      .toEqual(['ss400-saeki-1995-eq9', false, false]);
  });
});
