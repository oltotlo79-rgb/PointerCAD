import { describe, expect, it } from 'vitest';
import { analyzeLocalCycle, swtParameterAt, validateLocalCycleInput, type LocalCycleResult } from './fatigueLocalCycle.js';

/* Manufactured, test-only coefficients (not SS400, S45C or any real material) and hand-made local cycle extrema.
 * Every expected life comes from a closed form or from the relation written out here with Math.pow, never from the
 * production solver:
 *  - b == c == -0.5, E = 200000, sigma_f' = 1000, eps_f' = 0.995:
 *      SWT: sigma_f'^2/E + sigma_f' eps_f' = 5 + 995 = 1000, so sigma_max eps_a = 1000 / (2N)  =>  2N = 1000 / (sigma_max eps_a);
 *      Morrow: eps_a = ((1000 - sigma_m)/200000 + 0.995) (2N)^-0.5  =>  2N = (((1000 - sigma_m)/200000 + 0.995) / eps_a)^2.
 *  - b = -0.1, c = -0.6, eps_f' = 0.5: SWT right side 5 (2N)^-0.2 + 500 (2N)^-0.7; both terms equal 5 * 10^-0.8 at 2N = 1e4.
 * N is cycles and 2N reversals; a solver that used N in place of 2N would report twice these lives. */
const source = { kind: 'user-supplied', reference: 'Test-only manufactured coefficients; not a material value',
  condition: 'Hand-derived example' } as const;
const material = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured',
  stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration: { minimumCycles: 1, maximumCycles: 1e6 },
  source, ...overrides });
const unequal = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  material({ fatigueStrengthExponent: -0.1, fatigueDuctilityCoefficient: 0.5, fatigueDuctilityExponent: -0.6, ...overrides });
const cycle = (strainMax: unknown, strainMin: unknown, stressMax: unknown, stressMin: unknown,
  overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ strainMeasure: 'local-total-strain',
  strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'measured', strainMax, strainMin, stressMax, stressMin, source,
  ...overrides });
const input = (correction: unknown, local: unknown, mat: unknown = material()): Record<string, unknown> =>
  ({ schema: 'pointercad-strain-life-local-cycle/1', correction, material: mat, cycle: local });
function life(value: unknown): LocalCycleResult {
  const analysis = analyzeLocalCycle(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
const refusal = (value: unknown): readonly [string, string] => {
  const analysis = analyzeLocalCycle(value);
  return analysis.ok ? ['accepted', ''] : [analysis.code, analysis.path];
};
const near = (actual: number, expected: number, relative = 1e-9): void => {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relative * Math.abs(expected));
};

describe('SWT closed forms and trends', () => {
  it('solves b == c in reversals: sigma_max 500, eps_a 0.01 gives 2N = 1000 / 5 = 200, N = 100', () => {
    const result = life(input('swt', cycle(0.01, -0.01, 500, -300)));
    near(result.cyclesToFailure, 100);
    expect(result.reversalsToFailure).toBe(2 * result.cyclesToFailure);
    near(result.swtParameterMpa ?? Number.NaN, 5);
    expect([result.strainAmplitude, result.meanStressMpa, result.maximumStressMpa]).toEqual([0.01, 100, 500]);
    expect(result.method).toBe('basquin-coffin-manson/1+smith-watson-topper/1');
  });
  it('gives a shorter life for a larger maximum stress at the same strain amplitude', () => {
    const lower = life(input('swt', cycle(0.01, -0.01, 300, -500)));
    near(lower.cyclesToFailure, 1000 / 3 / 2);
    expect(life(input('swt', cycle(0.01, -0.01, 500, -300))).cyclesToFailure).toBeLessThan(lower.cyclesToFailure);
  });
  it('finds the equal-term life for b != c: 2N = 1e4 when sigma_max eps_a = 10 * 10^-0.8', () => {
    const product = 10 * 10 ** -0.8;
    near(life(input('swt', cycle(0.02, -0.02, product / 0.02, -product / 0.02), unequal())).cyclesToFailure, 5000);
  });
  it.each([3, 50, 5000, 2e5])('returns %s cycles for the SWT product the relation gives at 2N (b != c)', cycles => {
    const reversals = 2 * cycles;
    const product = 1000 ** 2 / 200_000 * reversals ** -0.2 + 1000 * 0.5 * reversals ** -0.7;
    const result = life(input('swt', cycle(0.02, -0.02, product / 0.02, -100), unequal()));
    near(result.cyclesToFailure, cycles);
    expect(Math.abs(result.solver.relativeResidual)).toBeLessThanOrEqual(1e-11);
  });
  it('refuses a zero or negative maximum stress as outside SWT applicability, never as an infinite life', () => {
    expect(refusal(input('swt', cycle(0.01, -0.01, 0, -500)))).toEqual(['swt-nonpositive-maximum-stress', 'cycle.stressMax']);
    expect(refusal(input('swt', cycle(0.01, -0.01, -10, -500)))).toEqual(['swt-nonpositive-maximum-stress', 'cycle.stressMax']);
  });
  it('handles a tiny positive maximum stress without an infinite life', () => {
    // 1e-6 MPa * 0.01 = 1e-8 MPa is below the curve at 2e6 reversals (1000 / 2e6 = 5e-4): longer than calibrated.
    expect(refusal(input('swt', cycle(0.01, -0.01, 1e-6, -500)))).toEqual(['strain-life-longer-than-calibration', 'cycle']);
    // The smallest positive stress times 0.01 is not representable: refused, not treated as zero damage.
    expect(refusal(input('swt', cycle(0.01, -0.01, Number.MIN_VALUE, -500)))).toEqual(['swt-parameter-underflow', 'cycle.stressMax']);
  });
});

describe('Morrow from the local cycle extrema', () => {
  it('shortens the life for a tensile mean and lengthens it for a compressive mean', () => {
    // sigma_m = +100: 2N = (0.9995 / 0.01)^2 = 9990.0025; sigma_m = -100: 2N = (1.0005 / 0.01)^2 = 10010.0025.
    const tensile = life(input('morrow', cycle(0.01, -0.01, 500, -300)));
    const zero = life(input('morrow', cycle(0.01, -0.01, 400, -400)));
    const compressive = life(input('morrow', cycle(0.01, -0.01, 300, -500)));
    near(tensile.cyclesToFailure, 4995.00125);
    near(zero.cyclesToFailure, 5000);
    near(compressive.cyclesToFailure, 5005.00125);
    expect([tensile.meanStressMpa, tensile.swtParameterMpa, tensile.method])
      .toEqual([100, null, 'basquin-coffin-manson/1+morrow-elastic-term/1']);
    expect(tensile.reversalsToFailure).toBe(2 * tensile.cyclesToFailure);
  });
  it('matches the relation written out here for b != c', () => {
    // eps_a at 2N = 1e4 with sigma_m = 200: (800 / 200000) 1e4^-0.1 + 0.5 1e4^-0.6.
    const amplitude = 800 / 200_000 * 1e4 ** -0.1 + 0.5 * 1e4 ** -0.6;
    near(life(input('morrow', cycle(amplitude, -amplitude, 700, -300), unequal())).cyclesToFailure, 5000);
  });
  it('reports a mean stress at or above sigma_f\' as an unsupported domain instead of clamping it', () => {
    expect(refusal(input('morrow', cycle(0.01, -0.01, 1100, 900)))).toEqual(['strain-life-morrow-domain', 'cycle']);
    expect(refusal(input('morrow', cycle(0.01, -0.01, 1500, 700)))).toEqual(['strain-life-morrow-domain', 'cycle']);
  });
});

describe('calibrated life interval (no extrapolation)', () => {
  // b == c == -0.5 on [50, 5000] cycles: the SWT right side is 1000 / 100 = 10 at 2N = 100 and 0.1 at 2N = 1e4.
  const calibrated = material({ calibration: { minimumCycles: 50, maximumCycles: 5000 } });
  function validMaterial() {
    const checked = validateLocalCycleInput(input('swt', cycle(0.01, -0.01, 1, -1), calibrated));
    if (!checked.ok) throw new Error(checked.code);
    return checked.input.material;
  }
  it('includes both endpoints exactly (eps_a 0.5 makes sigma_max eps_a exact)', () => {
    const atShortest = swtParameterAt(validMaterial(), 100), atLongest = swtParameterAt(validMaterial(), 1e4);
    if (atShortest === null || atLongest === null) throw new Error('calibrated endpoints must be evaluable');
    near(atShortest, 10, 1e-12);
    near(atLongest, 0.1, 1e-12);
    const shortest = life(input('swt', cycle(0.5, -0.5, 2 * atShortest, -1), calibrated));
    const longest = life(input('swt', cycle(0.5, -0.5, 2 * atLongest, -1), calibrated));
    expect([shortest.cyclesToFailure, shortest.solver.iterations]).toEqual([50, 0]);
    expect([longest.cyclesToFailure, longest.solver.iterations]).toEqual([5000, 0]);
  });
  it('refuses a demand just outside either end', () => {
    expect(refusal(input('swt', cycle(0.5, -0.5, 20 * (1 + 1e-9), -1), calibrated)))
      .toEqual(['strain-life-shorter-than-calibration', 'cycle']);
    expect(refusal(input('swt', cycle(0.5, -0.5, 0.2 * (1 - 1e-9), -1), calibrated)))
      .toEqual(['strain-life-longer-than-calibration', 'cycle']);
    expect(refusal(input('morrow', cycle(0.1 * (1 + 1e-9), -0.1 * (1 + 1e-9), 1, -1), calibrated)))
      .toEqual(['strain-life-shorter-than-calibration', 'cycle']);
  });
  it('does not evaluate the SWT curve outside the interval', () => {
    for (const reversals of [99.99, 10_000.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(swtParameterAt(validMaterial(), reversals)).toBeNull();
    }
  });
});

describe('result contract', () => {
  it('states the scope without certification, serializes without loss and copies its input', () => {
    const local = cycle(0.01, -0.01, 500, -300);
    const result = life(input('swt', local));
    expect(result).toMatchObject({ schema: 'pointercad-strain-life-local-cycle-result/1',
      scope: 'uniaxial-constant-amplitude-local-cycle-strain-life-estimate', codeCompliance: false,
      structuralCertification: false, materialId: 'manufactured', correction: 'swt' });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    const checked = validateLocalCycleInput(input('swt', local));
    local.stressMax = 1;
    expect(checked.ok ? checked.input.cycle.stressMax : null).toBe(500);
  });
});

describe('malformed input (typed refusals, never a thrown error)', () => {
  const valid = (): Record<string, unknown> => cycle(0.01, -0.01, 500, -300);
  const cases: [string, unknown, string, string][] = [
    ['null', null, 'local-cycle-shape', '$'],
    ['missing correction', { schema: 'pointercad-strain-life-local-cycle/1', material: material(), cycle: valid() }, 'local-cycle-shape', '$'],
    ['schema', { ...input('swt', valid()), schema: 'pointercad-strain-life-local-cycle/2' }, 'local-cycle-schema', 'schema'],
    ['unknown correction', input('goodman', valid()), 'local-cycle-correction', 'correction'],
    ['correction holding undefined', input(undefined, valid()), 'local-cycle-correction', 'correction'],
    ['material modulus in GPa', input('swt', valid(), material({ elasticModulusMpa: 206 })), 'strain-life-bound', 'material.elasticModulusMpa'],
    ['material missing', input('swt', valid(), null), 'strain-life-shape', 'material'],
    ['material calibration reversed', input('swt', valid(), material({ calibration: { minimumCycles: 10, maximumCycles: 1 } })),
      'strain-life-calibration', 'material.calibration.maximumCycles'],
    ['extra cycle field', input('swt', { ...valid(), stressAmplitude: 400 }), 'local-cycle-shape', 'cycle'],
    ['cycle missing', input('swt', null), 'local-cycle-shape', 'cycle'],
    ['elastic stress as strain', input('swt', cycle(0.01, -0.01, 500, -300, { strainMeasure: 'elastic-stress-over-modulus' })),
      'local-cycle-strain-measure', 'cycle.strainMeasure'],
    ['linear-elastic derivation', input('swt', cycle(0.01, -0.01, 500, -300, { derivation: 'linear-elastic' })),
      'local-cycle-strain-measure', 'cycle.derivation'],
    ['strain in percent', input('swt', cycle(0.01, -0.01, 500, -300, { strainUnit: 'percent' })), 'local-cycle-unit', 'cycle.strainUnit'],
    ['stress in GPa', input('swt', cycle(0.01, -0.01, 500, -300, { stressUnit: 'GPa' })), 'local-cycle-unit', 'cycle.stressUnit'],
    ['strain max holding undefined', input('swt', cycle(undefined, -0.01, 500, -300)), 'local-cycle-number', 'cycle.strainMax'],
    ['strain max NaN', input('swt', cycle(Number.NaN, -0.01, 500, -300)), 'local-cycle-number', 'cycle.strainMax'],
    ['stress max infinite', input('swt', cycle(0.01, -0.01, Number.POSITIVE_INFINITY, -300)), 'local-cycle-number', 'cycle.stressMax'],
    ['stress min text', input('swt', cycle(0.01, -0.01, 500, '-300')), 'local-cycle-number', 'cycle.stressMin'],
    ['strain beyond 1', input('swt', cycle(1.5, -0.01, 500, -300)), 'local-cycle-bound', 'cycle.strainMax'],
    ['stress beyond the limit', input('swt', cycle(0.01, -0.01, 2e4, -300)), 'local-cycle-bound', 'cycle.stressMax'],
    ['equal strain extrema', input('swt', cycle(0.01, 0.01, 500, -300)), 'local-cycle-extrema', 'cycle.strainMin'],
    ['reversed strain extrema', input('swt', cycle(-0.01, 0.01, 500, -300)), 'local-cycle-extrema', 'cycle.strainMin'],
    ['equal stress extrema', input('swt', cycle(0.01, -0.01, 300, 300)), 'local-cycle-extrema', 'cycle.stressMin'],
    ['reversed stress extrema', input('morrow', cycle(0.01, -0.01, -300, 500)), 'local-cycle-extrema', 'cycle.stressMin'],
    ['blank source', input('swt', cycle(0.01, -0.01, 500, -300, { source: { ...source, reference: ' ' } })), 'local-cycle-source', 'cycle.source'],
    ['source shape', input('swt', cycle(0.01, -0.01, 500, -300, { source: 'test' })), 'local-cycle-shape', 'cycle.source'],
  ];
  it.each(cases)('%s', (_name, value, code, path) => {
    expect(refusal(value)).toEqual([code, path]);
    const checked = validateLocalCycleInput(value);
    const verdict = checked.ok ? ['accepted', ''] : [checked.code, checked.path];
    // Domain checks belong to the analysis; malformed input is refused by the reader with the same code and path.
    expect(verdict).toEqual([code, path]);
  });
});
