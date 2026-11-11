import { describe, expect, it } from 'vitest';
import { analyzeFatigue } from './fatigue.js';
import { analyzeFatiguePiecewise, validateFatiguePiecewiseInput } from './fatiguePiecewise.js';
import { FATIGUE_SLOPE_LIMITS, MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS, MAX_FATIGUE_STRESS_MPA,
  validateFatigueInput } from './fatigueModel.js';

/* The slope (S-N exponent m) input bound 1..32. 32 is an input bound, not a material constant. The exponents
 * 24.096385542168672 and 30.674846625766875 are 1/A of the printed A = 0.0415 and 0.0326 (NIMS NRIM SR 93-02, S45C,
 * Tables A3(4) and A3(1)) computed by PointerCAD; every other curve value here is synthetic, no material curve is stated.
 * Expected damages follow by hand from N = Nref (Sref / S) ** m; the independent Python check is the owner's check8.py. */
const source = { kind: 'user-supplied', reference: 'Test-only relation; not a material value', condition: 'Hand-derived example' } as const;
const PRINTED_EXPONENTS = [24.096385542168672, 30.674846625766875] as const;
const curve = (slope: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'curve', unit: 'MPa',
  stressDefinition: 'range', meanStressAssumption: 'mean-independent', referenceStressMpa: 100, referenceCycles: 2e6, slope,
  cutoffStressMpa: null, source, ...overrides });
const history = (id: string, stressMpa: readonly number[], sequence = 'once', repeats = 1): Record<string, unknown> =>
  ({ id, unit: 'MPa', stressMpa, sequence, repeats, source });
const single = (curveValue: Record<string, unknown>, histories = [history('h', [0, 200, 0])]): Record<string, unknown> =>
  ({ schema: 'pointercad-fatigue/1', curve: curveValue, histories });
const piecewise = (segments: readonly Record<string, unknown>[], histories = [history('h', [125, -125], 'repeated-periodic')],
  overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: 'pointercad-fatigue-piecewise/1',
  curve: { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent', segments, endCycles: 1e12,
    end: 'cutoff-at-end', applicability: { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' }, source, ...overrides },
  histories });
const refusal = (checked: { ok: true } | { ok: false; code: string; path: string }): readonly [string, string] | null =>
  checked.ok ? null : [checked.code, checked.path];
const near = (actual: number, expected: number): void => { expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 * Math.abs(expected)); };
/** n alternating samples of +-1e4 MPa: closed-loop counting gives n half cycles of range 2e4 MPa. */
const extreme = (id: string, points: number): Record<string, unknown> => history(id,
  Array.from({ length: points }, (_, index) => (index % 2 === 0 ? MAX_FATIGUE_STRESS_MPA : -MAX_FATIGUE_STRESS_MPA)),
  'repeated-periodic', MAX_FATIGUE_REPEATS);

describe('slope input bound 1..32', () => {
  it('states the bound once in the core', () => {
    expect(FATIGUE_SLOPE_LIMITS).toEqual({ minimum: 1, maximum: 32 });
  });

  it('keeps 1..20 valid and accepts the printed exponents and 32 on a single-slope and a piecewise curve', () => {
    for (const slope of [1, 3, 20, ...PRINTED_EXPONENTS, 32]) {
      expect(refusal(validateFatigueInput(single(curve(slope)))), `single ${slope}`).toBeNull();
      expect(refusal(validateFatiguePiecewiseInput(piecewise([{ fromStressMpa: 400, fromCycles: 1e5, slope }]))), `piecewise ${slope}`)
        .toBeNull();
    }
  });

  it('refuses above 32 as a bound and NaN or infinities as a number, on both curves', () => {
    const cases: readonly (readonly [number, string])[] = [[32.000001, 'fatigue-bound'], [33, 'fatigue-bound'],
      [0.999, 'fatigue-bound'], [0, 'fatigue-bound'], [-1, 'fatigue-bound'], [Number.NaN, 'fatigue-number'],
      [Number.POSITIVE_INFINITY, 'fatigue-number'], [Number.NEGATIVE_INFINITY, 'fatigue-number']];
    for (const [slope, code] of cases) {
      expect(refusal(validateFatigueInput(single(curve(slope)))), `single ${slope}`).toEqual([code, 'curve.slope']);
      expect(refusal(validateFatiguePiecewiseInput(piecewise([{ fromStressMpa: 400, fromCycles: 1e5, slope }]))), `piecewise ${slope}`)
        .toEqual([code, 'curve.segments[0].slope']);
    }
  });

  it('gives the hand-derived damage with a printed exponent (S = Sref / 2, m = 1/0.0326)', () => {
    // Two half cycles of range 50 MPa against Sref 100 MPa, Nref 2e6: D = (1/2) ** m / 2e6.
    const slope = PRINTED_EXPONENTS[1];
    const analysis = analyzeFatigue(single(curve(slope), [history('h', [0, 50, 0])]));
    if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
    near(analysis.result.damage, 2 ** -slope / 2e6);
  });

  it('keeps the damage finite at the largest single-slope terms (m 32, Sref 1, Nref 1, range 2e4, 1e9 repeats)', () => {
    // 1e5 alternating samples -> 1e5 half cycles of range 2e4: D = 5e4 * 1e9 * (2e4) ** 32 = 2147483648e142 exactly in reals.
    const analysis = analyzeFatigue(single(curve(32, { referenceStressMpa: 1, referenceCycles: 1 }),
      [extreme('max', MAX_FATIGUE_HISTORY_POINTS)]));
    if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
    near(analysis.result.damage, 2.147483648e151);
    expect(analysis.result.life.kind).toBe('finite');
    // Every one of the 64 allowed histories at its largest term: D = 64 * 1e9 * (2e4) ** 32 (two-sample histories).
    const many = analyzeFatigue(single(curve(32, { referenceStressMpa: 1, referenceCycles: 1 }),
      Array.from({ length: MAX_FATIGUE_HISTORIES }, (_, index) => extreme(`h${index}`, 2))));
    if (!many.ok) throw new Error(`${many.code} at ${many.path}`);
    near(many.result.damage, 2.74877906944e148);
    expect(Number.isFinite(many.result.damage)).toBe(true);
  });

  it('keeps a slope-32 piecewise curve finite and continuous at a knee to a printed exponent', () => {
    // Knee: N = 1 * (1e4 / 5000) ** 32 = 2 ** 32 cycles at 5000 MPa on the first line.
    const segments = [{ fromStressMpa: 1e4, fromCycles: 1, slope: 32 }, { fromStressMpa: 5000, fromCycles: 2 ** 32, slope: PRINTED_EXPONENTS[1] }];
    const amplitude = { stressDefinition: 'amplitude' };
    const top = analyzeFatiguePiecewise(piecewise(segments, [extreme('max', MAX_FATIGUE_HISTORY_POINTS)], amplitude));
    if (!top.ok) throw new Error(`${top.code} at ${top.path}`);
    // Amplitude 1e4 is the first start: 1/N = 1 per cycle; 5e4 cycles per period, 1e9 periods.
    near(top.result.damage, 5e13);
    const knee = analyzeFatiguePiecewise(piecewise(segments, [history('h', [5000, -5000], 'repeated-periodic')], amplitude));
    if (!knee.ok) throw new Error(`${knee.code} at ${knee.path}`);
    near(knee.result.damage, 2 ** -32);
    expect(refusal(validateFatiguePiecewiseInput(piecewise([segments[0], { ...segments[1], fromCycles: 2 ** 32 * (1 + 1e-6) }]))))
      .toEqual(['fatigue-piecewise-continuity', 'curve.segments[1]']);
  });
});
