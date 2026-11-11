import { describe, expect, it } from 'vitest';
import { analyzeFatiguePiecewise, FATIGUE_PIECEWISE_INPUT_SCHEMA, piecewiseEndStressMpa } from './fatiguePiecewise.js';

/*
 * One MEASURED S-N series of a Japanese steel, connected to the existing piecewise input (W50/W03).
 * Source (printed values only): Y. Murakami, M. Takada, T. Toriyama, "S45C焼入れ・焼もどし材の超長寿命引張圧縮疲労特性"
 * (Super-long life tension-compression fatigue properties of quenched and tempered 0.46% carbon steel),
 * 材料 (J. Soc. Mat. Sci., Japan) 46(10) (1997) 1149-1154, J-STAGE PDF sha256
 * be7e5380e8d9b4352cecfd28ffef609082411fb2bbf136b2391d242d9a8b8bba.
 * Printed conditions (p.1150): commercial S45C rolled bar (1985, dia. 26 mm); annealed 845 C 1 h furnace cooled, quenched
 * 845 C 1 h into 20 C water, tempered 200 C 1 h, 20 C water; HV about 650; smooth specimen d = 7 mm, electropolished
 * about 50 um per diameter; tension-compression, load control, about 80 Hz, R = -1.0 (両振り) (p.1150).
 * Printed in Table II (p.1151): sigma column in MPa with the legend "σ : Stress.", Nf "Cycles to failure.".
 * Printed on p.1152 (left column): No.11 "負荷応力振幅σ=499.8MPa で繰返し数N=5.0x10^8 に耐えた" (= Table II row 11)
 * and "負荷応力振幅σの比σ/σw'" for Fig. 7 (= the sigma/sigma_w' column of Table II). Reading every row's sigma as
 * the AMPLITUDE rests on these two printed statements; that the amplitude also equals the peak stress is only an
 * inference from R = -1 (not printed per row). Nf is CYCLES to failure. The TEST TEMPERATURE IS NOT
 * STATED; no tensile or yield strength is printed. Nothing here is a guaranteed or standard value, and this series is
 * not the s45c-normalized-reference or s45c-quenched-tempered-reference strength row (different heat treatment, no
 * strength printed); it is not C45/AISI 1045 data either.
 *
 * The single-slope curve is THIS REPOSITORY'S OWN least-squares fit (log10 Nf on log10 sigma) of the nine printed
 * inclusion-origin (fish-eye) failures No. 2-9 and 12; the source prints no regression. Specimens No. 1 and 13 failed
 * from surface pits at about 5e4 cycles (upper step of the printed two-step S-N curve) and No. 10/11 did not fail at
 * 5.0e8; both lie outside the calibrated range and the curve REFUSES them (never extrapolated).
 * The constants below were computed independently in Python (owner fit47.py / loo47.py, double precision).
 */
const SOURCE = { kind: 'user-supplied',
  reference: 'Murakami, Takada, Toriyama, 材料 46(10) 1149-1154 (1997), Table II; single slope fitted by PointerCAD (not printed)',
  condition: 'S45C 845C quench, 200C temper, HV~650, smooth d=7 mm, tension-compression R=-1, ~80 Hz, test temperature not stated' } as const;
/** How the source prints the series. The conversion below accepts nothing else (no factor-of-two guess). */
const PRINTED = { stress: 'amplitude', life: 'cycles-to-failure', unit: 'MPa' } as const;
/** Table II, p.1151, printed values: [specimen No., sigma amplitude MPa, Nf cycles or null (not broken at 5.0e8), origin]. */
const TABLE_II: readonly (readonly [number, number, number | null, 'pit' | 'inclusion' | 'not-broken'])[] = [
  [1, 686, 5.30e4, 'pit'], [2, 646.8, 1.25e7, 'inclusion'], [3, 627.2, 9.27e6, 'inclusion'], [4, 607.6, 2.05e7, 'inclusion'],
  [5, 588, 3.11e7, 'inclusion'], [6, 568.4, 2.71e7, 'inclusion'], [7, 548.8, 1.71e7, 'inclusion'],
  [8, 529.2, 8.96e7, 'inclusion'], [9, 509.6, 9.70e7, 'inclusion'], [10, 490, null, 'not-broken'],
  [11, 499.8, null, 'not-broken'], [12, 666.4, 3.83e6, 'inclusion'], [13, 676.2, 5.94e4, 'pit'],
];
const RUNOUT_CYCLES = 5.0e8;
/** Python fit47.py / loo47.py (independent of this file and of the solver). */
const PY = { slope: 10.110201447827285, cyclesAt600: 17161789.193431363, fromCycles: 5938842.242096683,
  knownCycles: { 646.8: 8031197.755296867, 588: 21050804.85412195, 529.2: 61078189.14806436 } as Record<number, number>,
  looMaxRatio: 2.99392042738863 } as const;
/** Owner-regression domain: from the highest fitted amplitude 666.4 MPa, where the OWNER FIT gives PY.fromCycles
 * (5.938842e6; the printed life of No.12 there is 3.83e6), down to endCycles = the longest printed fitted life 9.70e7
 * (No.9), i.e. to an end amplitude of about 505.53 MPa. */
const FROM_STRESS_MPA = 666.4;
const END_CYCLES = 9.70e7;

interface PrintedDeclaration { readonly stress: string; readonly life: string; readonly unit: string }
interface MeasuredPoint { readonly amplitudeMpa: number; readonly cycles: number }
/** The fitted points in curve units. A declaration that differs from the printed one (range for amplitude, reversals
 * for cycles, another unit) is refused instead of being converted by an assumed factor of two. */
function fittedPoints(declared: PrintedDeclaration): MeasuredPoint[] {
  if (declared.stress !== PRINTED.stress || declared.life !== PRINTED.life || declared.unit !== PRINTED.unit) {
    throw new Error('declaration differs from the printed Table II (amplitude, cycles to failure, MPa)');
  }
  return TABLE_II.flatMap(([, amplitudeMpa, cycles, origin]) =>
    origin === 'inclusion' && cycles !== null ? [{ amplitudeMpa, cycles }] : []);
}
/** Least squares of log10 N on log10 S (independent re-derivation of the Python constants). */
function fitLogLog(points: readonly MeasuredPoint[]): { readonly slope: number; readonly life: (stress: number) => number } {
  const xs = points.map(point => Math.log10(point.amplitudeMpa)), ys = points.map(point => Math.log10(point.cycles));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (const [index, x] of xs.entries()) { sxy += (x - mx) * ((ys[index] ?? Number.NaN) - my); sxx += (x - mx) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  return { slope: -b, life: stress => 10 ** (a + b * Math.log10(stress)) };
}
function curve(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 's45c-qt200-murakami1997-fit', unit: 'MPa', stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only',
    segments: [{ fromStressMpa: FROM_STRESS_MPA, fromCycles: PY.fromCycles, slope: PY.slope }], endCycles: END_CYCLES, end: 'none',
    applicability: { material: 'S45C, 845C water quench + 200C temper, HV about 650 (Murakami et al. 1997); test temperature not stated',
      detail: 'smooth electropolished d=7 mm, tension-compression, R=-1, about 80 Hz, inclusion-origin failures',
      scope: 'owner-fit domain only: amplitude 505.5-666.4 MPa, i.e. owner-regression life 5.938842e6 cycles at 666.4 MPa (fromCycles; not printed) to endCycles 9.7e7; the printed fitted lives 3.83e6 (No.12) to 9.70e7 (No.9) are observations, not this domain; pit-origin step above and run-out region below are refused' },
    source: SOURCE, ...overrides };
}
/** One fully reversed period with peak `amplitude` (one closed cycle of range 2 x amplitude). */
function reversed(amplitude: number): Record<string, unknown> {
  return { id: 'h', unit: 'MPa', stressMpa: [amplitude, -amplitude], sequence: 'repeated-periodic', repeats: 1, source: SOURCE };
}
function analyze(curveValue: Record<string, unknown>, amplitude: number): ReturnType<typeof analyzeFatiguePiecewise> {
  return analyzeFatiguePiecewise({ schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curveValue, histories: [reversed(amplitude)] });
}
function lifeCycles(amplitude: number): number {
  const analysis = analyze(curve(), amplitude);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  if (analysis.result.life.kind !== 'finite') throw new Error(`life ${analysis.result.life.kind}`);
  return analysis.result.life.spectrumRepetitions;
}
const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);

describe('measured S45C (Q&T 200C) tension-compression S-N series on the piecewise input (not a guaranteed value)', () => {
  it('re-derives the Python fit from the printed table', () => {
    const points = fittedPoints(PRINTED);
    expect(points).toHaveLength(9);
    const fit = fitLogLog(points);
    expect(relative(fit.slope, PY.slope)).toBeLessThan(1e-9);
    expect(relative(fit.life(600), PY.cyclesAt600)).toBeLessThan(1e-9);
    expect(relative(fit.life(FROM_STRESS_MPA), PY.fromCycles)).toBeLessThan(1e-9);
  });

  it('gives the independently computed life at three printed amplitudes (MPa amplitude, full cycles) within 1e-6', () => {
    for (const amplitude of [646.8, 588, 529.2]) {
      const expected = PY.knownCycles[amplitude];
      if (expected === undefined) throw new Error('missing known point');
      expect(relative(lifeCycles(amplitude), expected)).toBeLessThanOrEqual(1e-6);
    }
  });

  // LIMITED REGRESSION CHECK of the owner fit (number conversion and saved form), NOT a physical or commercial accuracy
  // criterion: no independent source states the scatter expected under the original conditions. Python (build50/51)
  // ratios to the nine printed inclusion-origin lives: in-sample 0.6425-2.4729, leave-one-out 0.5514-2.9939 (max
  // PY.looMaxRatio). The 0.1-10 bounds only catch a broken unit/cycle conversion; they are not widened.
  it('limited regression check: in-sample and leave-one-out ratios to the nine printed inclusion-origin lives', () => {
    const points = fittedPoints(PRINTED);
    let looMax = 0;
    for (const [index, point] of points.entries()) {
      const inSample = lifeCycles(point.amplitudeMpa) / point.cycles;
      expect(inSample).toBeGreaterThanOrEqual(0.1);
      expect(inSample).toBeLessThanOrEqual(10);
      const left = fitLogLog(points.filter((_, other) => other !== index)).life(point.amplitudeMpa) / point.cycles;
      expect(left).toBeGreaterThanOrEqual(0.1);
      expect(left).toBeLessThanOrEqual(10);
      looMax = Math.max(looMax, left, 1 / left);
    }
    expect(relative(looMax, PY.looMaxRatio)).toBeLessThan(1e-9);
  });

  it('refuses the printed pit-origin failures above and the run-out amplitudes below the calibrated range', () => {
    const endStress = FROM_STRESS_MPA * (PY.fromCycles / END_CYCLES) ** (1 / PY.slope);
    expect(relative(piecewiseEndStressMpa({ segments: [{ fromStressMpa: FROM_STRESS_MPA, fromCycles: PY.fromCycles, slope: PY.slope }],
      endCycles: END_CYCLES }), endStress)).toBeLessThan(1e-12);
    for (const [, amplitude, cycles, origin] of TABLE_II) {
      if (origin === 'inclusion') continue;
      if (origin === 'not-broken') expect(cycles).toBeNull();
      expect(origin === 'pit' ? amplitude > FROM_STRESS_MPA : amplitude < endStress && RUNOUT_CYCLES > END_CYCLES).toBe(true);
      expect(analyze(curve(), amplitude)).toEqual({ ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' });
    }
  });

  it('refuses a range/amplitude mix-up in either direction instead of returning a life', () => {
    // The curve declared as a RANGE curve: the counted range 2 x 588 MPa exceeds the calibration.
    expect(analyze(curve({ stressDefinition: 'range' }), 588))
      .toEqual({ ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' });
    // The printed amplitude 588 MPa entered as a range (peak 294 MPa) falls below the calibrated end.
    expect(analyze(curve(), 588 / 2)).toEqual({ ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' });
    expect(() => fittedPoints({ ...PRINTED, stress: 'range' })).toThrow(/printed Table II/);
  });

  it('refuses reading the printed cycles as reversals (or another unit) instead of halving them', () => {
    expect(() => fittedPoints({ ...PRINTED, life: 'reversals-to-failure' })).toThrow(/printed Table II/);
    expect(() => fittedPoints({ ...PRINTED, unit: 'kgf/mm2' })).toThrow(/printed Table II/);
    // Had Nf been halved as reversals, every known life would be off by exactly 2, far beyond the 1e-6 tolerance.
    const halved = fitLogLog(fittedPoints(PRINTED).map(point => ({ amplitudeMpa: point.amplitudeMpa, cycles: point.cycles / 2 })));
    expect(relative(halved.life(588), 21050804.85412195 / 2)).toBeLessThan(1e-9);
    expect(relative(halved.life(588), lifeCycles(588))).toBeGreaterThan(0.49);
  });
});
