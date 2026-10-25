import { describe, expect, it } from 'vitest';
import { analyzeStrainHistory, STRAIN_HISTORY_INPUT_SCHEMA } from './fatigueStrainHistory.js';
import {
  analyzeStrainStressHistory, pairedReversalStress, STRAIN_STRESS_HISTORY_INPUT_SCHEMA, validateStrainStressHistoryInput,
} from './fatigueStrainStressHistory.js';

/*
 * Paired strain/stress history (F1). Expectations are written by hand, never read back from the implementation:
 * - the rainflow cycles of the strain peaks are counted by hand with the three-point rule (below);
 * - the mean stress of a cycle is the mean of the two paired stresses at its reversal samples;
 * - a life is checked FORWARD with the strain-life relation written here (Basquin + Coffin-Manson with Morrow's elastic
 *   term, the relation documented in fatigueStrainLife.ts lines 5-9):
 *     eps_a = (sf - sm) / E * (2N)^b + ef * (2N)^c,
 *   either by building the history from a chosen life N (known-life control) or by evaluating the relation at each
 *   reported life and comparing with the cycle's amplitude (residual control).
 * The material is test data with a stated source, not a built-in property.
 */
const MATERIAL = { id: 'test-steel', stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 900,
  fatigueStrengthExponent: -0.09, fatigueDuctilityCoefficient: 0.4, fatigueDuctilityExponent: -0.6,
  calibration: { minimumCycles: 10, maximumCycles: 1e7 },
  source: { kind: 'user-supplied', reference: 'Unit test coefficients (not a material datasheet)', condition: 'Test only' } } as const;
const SOURCE = { kind: 'user-supplied', reference: 'Unit test history', condition: 'Paired local strain and stress' } as const;
const curve = (cycles: number, meanStressMpa: number): number => {
  const reversals = 2 * cycles;
  return (MATERIAL.fatigueStrengthCoefficientMpa - meanStressMpa) / MATERIAL.elasticModulusMpa * reversals ** MATERIAL.fatigueStrengthExponent
    + MATERIAL.fatigueDuctilityCoefficient * reversals ** MATERIAL.fatigueDuctilityExponent;
};
type Sample = { timeSeconds: number; strain: number; stressMpa: number };
const samples = (strain: readonly number[], stress: readonly number[], times?: readonly number[]): Sample[] =>
  strain.map((value, index) => ({ timeSeconds: times?.[index] ?? index, strain: value, stressMpa: stress[index] ?? Number.NaN }));
function history(points: readonly Sample[], sequence: 'once' | 'repeated-periodic' = 'once', repeats = 1, id = 'h1') {
  return { id, strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress', stressUnit: 'MPa',
    timeUnit: 'second', derivation: 'measured', samples: points, sequence, repeats, source: SOURCE };
}
const input = (...histories: readonly ReturnType<typeof history>[]) =>
  ({ schema: STRAIN_STRESS_HISTORY_INPUT_SCHEMA, meanStress: 'morrow-paired-reversal-stress', material: MATERIAL, histories });

/*
 * Hand rainflow of the once-history strain peaks [0, 4, -2, 3, -4, 0] x 1e-3 (samples 0..5, all turning points):
 *   [0,4,-2]: X=6 >= Y=4, three on the stack -> half (0 -> 4), samples 0 -> 1, amplitude 2e-3;
 *   [4,-2,3]: X=5 < Y=6;  [4,-2,3,-4]: X=7 >= Y=5 -> full (-2 -> 3), samples 2 -> 3, amplitude 2.5e-3;
 *   [4,-4,0]: X=4 < Y=8;  remaining halves (4 -> -4) samples 1 -> 4 amplitude 4e-3, (-4 -> 0) samples 4 -> 5 amplitude 2e-3.
 */
const PEAKS = [0, 0.004, -0.002, 0.003, -0.004, 0];
const PEAK_STRESS = [20, 520, -180, 430, -460, 40];
const HAND_CYCLES = [
  { count: 0.5, fromIndex: 0, toIndex: 1, strainAmplitude: 0.002, meanStressMpa: (20 + 520) / 2 },
  { count: 1, fromIndex: 2, toIndex: 3, strainAmplitude: 0.0025, meanStressMpa: (-180 + 430) / 2 },
  { count: 0.5, fromIndex: 1, toIndex: 4, strainAmplitude: 0.004, meanStressMpa: (520 - 460) / 2 },
  { count: 0.5, fromIndex: 4, toIndex: 5, strainAmplitude: 0.002, meanStressMpa: (-460 + 40) / 2 },
];

describe('paired strain/stress history: lives and cycle mean stresses', () => {
  it('reproduces a chosen life: the history is built from N = 1e4 cycles at a mean stress of 150 MPa', () => {
    const cycles = 1e4, mean = 150, amplitude = curve(cycles, mean);
    // One periodic loop between +eps_a and -eps_a whose paired stresses average to 150 MPa.
    const analysis = analyzeStrainStressHistory(input(history(samples([amplitude, -amplitude], [mean + 300, mean - 300]), 'repeated-periodic')));
    if (!analysis.ok) throw new Error(`${analysis.code} ${analysis.path}`);
    // By hand: the periodic reversals are [+a, -a, +a] (restarted and closed at the largest value); the three-point rule
    // counts a half (+a -> -a) with three on the stack and leaves a half (-a -> +a): one loop as two halves.
    const counted = analysis.result.histories[0]?.cycles ?? [];
    expect(counted.map(cycle => [cycle.count, cycle.fromIndex, cycle.toIndex, cycle.meanStressMpa])).toEqual([[0.5, 0, 1, 150], [0.5, 1, 0, 150]]);
    for (const cycle of counted) expect(cycle.cyclesToFailure).toBeCloseTo(cycles, 3);
    expect(analysis.result.life.kind).toBe('finite');
    if (analysis.result.life.kind !== 'finite') throw new Error('Expected finite life');
    expect(analysis.result.life).toEqual({ kind: 'finite', spectrumRepetitions: analysis.result.life.spectrumRepetitions });
    expect(analysis.result.life.spectrumRepetitions).toBeCloseTo(cycles, 3);
    // The same amplitude without mean stress lives longer (Morrow lowers the elastic term for a tensile mean).
    const zeroMean = analyzeStrainStressHistory(input(history(samples([amplitude, -amplitude], [300, -300]), 'repeated-periodic')));
    expect(zeroMean.ok && zeroMean.result.histories[0]?.cycles[0]?.cyclesToFailure).toBeGreaterThan(cycles);
  });

  it('pairs every hand-counted cycle with the stresses at its reversal samples and sums Miner damage', () => {
    const analysis = analyzeStrainStressHistory(input(history(samples(PEAKS, PEAK_STRESS))));
    if (!analysis.ok) throw new Error(`${analysis.code} ${analysis.path}`);
    const entry = analysis.result.histories[0];
    expect(entry?.reversals).toBe(6);
    expect(entry?.cycles.map(cycle => ({ count: cycle.count, fromIndex: cycle.fromIndex, toIndex: cycle.toIndex,
      meanStressMpa: cycle.meanStressMpa }))).toEqual(HAND_CYCLES.map(cycle =>
      ({ count: cycle.count, fromIndex: cycle.fromIndex, toIndex: cycle.toIndex, meanStressMpa: cycle.meanStressMpa })));
    for (const [index, expected] of HAND_CYCLES.entries()) {
      expect(entry?.cycles[index]?.strainAmplitude).toBeCloseTo(expected.strainAmplitude, 15);
    }
    for (const cycle of entry?.cycles ?? []) {
      expect(cycle.stressAtFromMpa).toBe(PEAK_STRESS[cycle.fromIndex]);
      expect(cycle.stressAtToMpa).toBe(PEAK_STRESS[cycle.toIndex]);
      // Forward residual of the documented relation at the reported life.
      expect(curve(cycle.cyclesToFailure, cycle.meanStressMpa) / cycle.strainAmplitude).toBeCloseTo(1, 9);
    }
    const damage = (entry?.cycles ?? []).reduce((sum, cycle) => sum + cycle.count / cycle.cyclesToFailure, 0);
    expect(entry?.damage).toBeCloseTo(damage, 15);
    expect(analysis.result.damage).toBe(entry?.damage);
    expect(analysis.result.meanStress).toBe('morrow-paired-reversal-stress');
    expect([analysis.result.codeCompliance, analysis.result.structuralCertification]).toEqual([false, false]);
  });

  it('keeps the result when only non-reversal samples and times change, and changes it when the reversal stresses change', () => {
    const base = analyzeStrainStressHistory(input(history(samples(PEAKS, PEAK_STRESS))));
    // Intermediate ramp samples (strictly between neighbouring peaks, any stress) and stretched times: same reversals,
    // same paired stresses, same cycles.
    const strain: number[] = [], stress: number[] = [], times: number[] = [];
    PEAKS.forEach((value, index) => {
      strain.push(value); stress.push(PEAK_STRESS[index] ?? Number.NaN); times.push(10 * index);
      const next = PEAKS[index + 1];
      if (next !== undefined) { strain.push((value + next) / 2); stress.push(999 - index); times.push(10 * index + 3); }
    });
    const ramps = analyzeStrainStressHistory(input(history(samples(strain, stress, times))));
    if (!base.ok || !ramps.ok) throw new Error('refused');
    expect(ramps.result.damage).toBe(base.result.damage);
    expect(ramps.result.histories[0]?.cycles.map(cycle => [cycle.count, cycle.meanStressMpa, cycle.cyclesToFailure]))
      .toEqual(base.result.histories[0]?.cycles.map(cycle => [cycle.count, cycle.meanStressMpa, cycle.cyclesToFailure]));
    // The same strain peaks with the reversal stresses of the full cycle swapped with the first half's: other means.
    const swapped = [430, 520, -180, 20, -460, 40];
    const changed = analyzeStrainStressHistory(input(history(samples(PEAKS, swapped))));
    if (!changed.ok) throw new Error('refused');
    expect(changed.result.histories[0]?.cycles.map(cycle => cycle.meanStressMpa)).toEqual([(430 + 520) / 2, (-180 + 20) / 2,
      (520 - 460) / 2, (-460 + 40) / 2]);
    expect(changed.result.damage).not.toBe(base.result.damage);
    // Reordering the strain peaks changes the counted cycles themselves. By hand, [0, 3, -2, 4, -4, 0] x 1e-3 counts the
    // halves 0 -> 3, 3 -> -2, -2 -> 4 (three on the stack each time), then the halves 4 -> -4 and -4 -> 0:
    // amplitudes 1.5, 2.5, 3, 4, 2 (x 1e-3) instead of 2, 2.5, 4, 2. (The mirror order [0, -4, 3, -2, 4, 0] would give
    // the same amplitudes and is therefore not a control.)
    const reordered = analyzeStrainStressHistory(input(history(samples([0, 0.003, -0.002, 0.004, -0.004, 0], [20, 430, -180, 520, -460, 40]))));
    if (!reordered.ok) throw new Error('refused');
    const reorderedAmplitudes = reordered.result.histories[0]?.cycles.map(cycle => cycle.strainAmplitude);
    const expectedAmplitudes = [0.0015, 0.0025, 0.003, 0.004, 0.002];
    expect(reorderedAmplitudes?.length).toBe(expectedAmplitudes.length);
    for (const [index, expected] of expectedAmplitudes.entries()) {
      expect(reorderedAmplitudes?.[index]).toBeCloseTo(expected, 15);
    }
    expect(reordered.result.damage).not.toBe(base.result.damage);
  });

  it('equals the existing zero-mean strain history when every paired cycle mean stress is zero', () => {
    const strain = [0.003, -0.003, 0.003, -0.003];
    const paired = analyzeStrainStressHistory(input(history(samples(strain, [300, -300, 300, -300]), 'repeated-periodic', 1000)));
    const strainOnly = analyzeStrainHistory({ schema: STRAIN_HISTORY_INPUT_SCHEMA, meanStress: 'assumed-zero', material: MATERIAL,
      histories: [{ id: 'h1', strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured', strain,
        sequence: 'repeated-periodic', repeats: 1000, source: SOURCE }] });
    if (!paired.ok || !strainOnly.ok) throw new Error('refused');
    expect(paired.result.histories[0]?.cycles.every(cycle => cycle.meanStressMpa === 0)).toBe(true);
    expect(paired.result.damage).toBeCloseTo(strainOnly.result.damage, 12);
    // The strain-only history itself still refuses Morrow: its contract is unchanged.
    expect(analyzeStrainHistory({ schema: STRAIN_HISTORY_INPUT_SCHEMA, meanStress: 'morrow', material: MATERIAL, histories: [] }))
      .toEqual({ ok: false, code: 'strain-history-mean-unsupported', path: 'meanStress' });
  });

  it('reports a history without a strain cycle as such, never as an infinite or zero-damage life', () => {
    const analysis = analyzeStrainStressHistory(input(history(samples([0.001, 0.001], [100, 100]))));
    expect(analysis.ok && analysis.result.life).toEqual({ kind: 'no-strain-cycle' });
  });
});

describe('paired strain/stress history: refusals that name the failing sample or cycle', () => {
  const at = (strain: readonly number[], stress: readonly number[], times?: readonly number[], sequence: 'once' | 'repeated-periodic' = 'once') =>
    analyzeStrainStressHistory(input(history(samples(strain, stress, times), sequence)));

  it('refuses duplicated and non-monotonic times instead of merging or sorting samples', () => {
    expect(at([0, 0.002, -0.002], [0, 200, -200], [0, 1, 1]))
      .toEqual({ ok: false, code: 'strain-stress-history-time-order', path: 'histories[0].samples[2].timeSeconds' });
    expect(at([0, 0.002, -0.002], [0, 200, -200], [0, 2, 1]))
      .toEqual({ ok: false, code: 'strain-stress-history-time-order', path: 'histories[0].samples[2].timeSeconds' });
  });

  it('refuses a reversal whose plateau carries two stresses, and a periodic history that does not close', () => {
    expect(at([0, 0.004, 0.004, -0.004], [0, 400, 380, -400]))
      .toEqual({ ok: false, code: 'strain-stress-history-ambiguous-reversal-stress', path: 'histories[0].samples[2].stressMpa' });
    expect(pairedReversalStress({ samples: samples([0, 0.004, 0.004, -0.004], [0, 400, 400, -400]), sequence: 'once' }, 'h'))
      .toEqual({ ok: true, stressAt: new Map([[0, 0], [1, 400], [3, -400]]) });
    expect(at([0.003, -0.003, 0.003], [300, -300, 290], undefined, 'repeated-periodic'))
      .toEqual({ ok: false, code: 'strain-stress-history-periodic-closure', path: 'histories[0].samples[2].stressMpa' });
  });

  it('refuses a cycle mean stress outside the Morrow domain and a life outside the calibration, naming the cycle', () => {
    // Mean stress (1300 + 700) / 2 = 1000 MPa >= sigma_f' = 900 MPa.
    expect(at([0.002, -0.002], [1300, 700], undefined, 'repeated-periodic'))
      .toEqual({ ok: false, code: 'strain-life-morrow-domain', path: 'histories[0].cycles[0]' });
    // eps_a = 0.5 is far above the curve at 10 cycles.
    expect(at([0.5, -0.5], [100, -100], undefined, 'repeated-periodic'))
      .toEqual({ ok: false, code: 'strain-life-shorter-than-calibration', path: 'histories[0].cycles[0]' });
  });

  it('refuses malformed samples, units, bounds and the mean-stress statement', () => {
    const good = history(samples([0, 0.002], [0, 200]));
    const code = (value: unknown) => {
      const checked = validateStrainStressHistoryInput(value);
      return checked.ok ? 'ok' : `${checked.code} ${checked.path}`;
    };
    expect(code(input(good))).toBe('ok');
    expect(code({ ...input(good), meanStress: 'assumed-zero' })).toBe('strain-stress-history-mean-assumption meanStress');
    expect(code({ ...input(good), schema: 'pointercad-strain-history/1' })).toBe('strain-stress-history-schema schema');
    expect(code(input({ ...good, stressUnit: 'kPa' }))).toBe('strain-stress-history-unit histories[0].stressUnit');
    expect(code(input({ ...good, timeUnit: 'ms' }))).toBe('strain-stress-history-unit histories[0].timeUnit');
    expect(code(input({ ...good, stressMeasure: 'nominal-stress' }))).toBe('strain-stress-history-measure histories[0].stressMeasure');
    expect(code(input(history(samples([0, 2], [0, 200]))))).toBe('strain-stress-history-bound histories[0].samples[1].strain');
    expect(code(input(history(samples([0, 0.002], [0, 2e4]))))).toBe('strain-stress-history-bound histories[0].samples[1].stressMpa');
    expect(code(input(history(samples([0, 0.002], [0, Number.NaN]))))).toBe('strain-stress-history-number histories[0].samples[1].stressMpa');
    expect(code({ ...input(good), histories: [{ ...good, samples: [{ timeSeconds: 0, strain: 0 }] }] })).toBe('strain-stress-history-shape histories[0].samples[0]');
    expect(code({ ...input(good), histories: [{ ...good, samples: [{ timeSeconds: 0, strain: 0, stressMpa: 0, temperature: 20 }] }] })).toBe('strain-stress-history-shape histories[0].samples[0]');
    expect(code(input(history([])))).toBe('strain-stress-history-length histories[0].samples');
    expect(code(input(good, good))).toBe('strain-stress-history-id histories[1].id');
    expect(code(input(history(samples([0, 0.002], [0, 200]), 'once', 2)))).toBe('strain-stress-history-repeats histories[0].repeats');
    expect(code({ ...input(good), material: { ...MATERIAL, elasticModulusMpa: 200 } })).toBe('strain-life-bound material.elasticModulusMpa');
  });

  it('returns fresh values: mutating the input after validation does not change an analysis', () => {
    const points = samples(PEAKS, PEAK_STRESS);
    const checked = validateStrainStressHistoryInput(input(history(points)));
    if (!checked.ok) throw new Error('refused');
    const first = points[1];
    if (first !== undefined) first.stressMpa = -999;
    expect(checked.input.histories[0]?.samples[1]?.stressMpa).toBe(520);
  });
});

/*
 * Life of a repeated input with a one-time paired record. A 'once' record can occur again only after its strain has
 * returned to its first value, so a recurrence is counted closed-loop with the paired stresses of the same reversal
 * samples; the single pass keeps its half cycles and their paired stresses. Lives are built FORWARD with the relation
 * `curve` above (known-life control); no expectation is read back from the solver.
 */
describe('paired strain/stress history: life of a repeated one-time record', () => {
  it('a -> -a once at a paired mean of 150 MPa: half a cycle per pass, one full cycle per recurrence', () => {
    const cycles = 1e4, mean = 150, amplitude = curve(cycles, mean);
    const analysis = analyzeStrainStressHistory(input(history(samples([amplitude, -amplitude], [mean + 300, mean - 300]))));
    if (!analysis.ok) throw new Error(`${analysis.code} ${analysis.path}`);
    const counted = analysis.result.histories[0]?.cycles ?? [];
    expect(counted.map(cycle => [cycle.count, cycle.fromIndex, cycle.toIndex, cycle.stressAtFromMpa, cycle.stressAtToMpa]))
      .toEqual([[0.5, 0, 1, 450, -150]]);
    expect(counted[0]?.cyclesToFailure).toBeCloseTo(cycles, 3);
    expect(analysis.result.damage).toBeCloseTo(0.5 / cycles, 12);
    // Recurring a, -a, a, ...: one full cycle at the same paired mean per application (before: 2e4 applications).
    expect(analysis.result.life.kind).toBe('finite');
    if (analysis.result.life.kind !== 'finite') throw new Error('Expected finite life');
    expect(analysis.result.life).toEqual({ kind: 'finite', spectrumRepetitions: analysis.result.life.spectrumRepetitions });
    expect(analysis.result.life.spectrumRepetitions).toBeCloseTo(cycles, 3);
  });

  it('wraps the last sample onto the first reversal only when both carry one stress, and refuses otherwise', () => {
    const amplitude = curve(1e4, 0);
    // -a, a, -a: on recurrence the last -a joins the first one, a reversal of every recurring cycle. With the same stress
    // (-300 MPa) both recurring halves have mean (300 - 300) / 2 = 0, so one full cycle at N = 1e4 per application.
    const closed = analyzeStrainStressHistory(input(history(samples([-amplitude, amplitude, -amplitude], [-300, 300, -300]))));
    if (!closed.ok) throw new Error(`${closed.code} ${closed.path}`);
    expect(closed.result.life.kind).toBe('finite');
    if (closed.result.life.kind !== 'finite') throw new Error('Expected finite life');
    expect(closed.result.life).toEqual({ kind: 'finite', spectrumRepetitions: closed.result.life.spectrumRepetitions });
    expect(closed.result.life.spectrumRepetitions).toBeCloseTo(1e4, 3);
    // The last sample carries -290 MPa: the wrapped reversal has no single stress. Refused at that sample; the user's
    // samples are not changed, and the single pass alone (no recurrence) would not need that stress.
    const typed = input(history(samples([-amplitude, amplitude, -amplitude], [-300, 300, -290])));
    const before = JSON.stringify(typed);
    expect(analyzeStrainStressHistory(typed))
      .toEqual({ ok: false, code: 'strain-stress-history-recurrence-closure', path: 'histories[0].samples[2].stressMpa' });
    expect(JSON.stringify(typed)).toBe(before);
  });

  it('refuses a recurring cycle outside the calibrated interval, named as a recurrence cycle', () => {
    // x, 3x, 0, 2x once (x = 1.5e-3, every paired stress 0 MPa): single-pass amplitudes x and 1.5x; on recurrence the
    // closing 2x -> x is a full cycle of amplitude 0.5x. Forward checks of the relation: amplitude 0.5x is below the curve
    // at the calibrated 1e7 cycles (longer than calibrated) while x and 1.5x lie between the curve at 1e7 and at 10 cycles.
    const x = 0.0015;
    expect(curve(MATERIAL.calibration.maximumCycles, 0)).toBeGreaterThan(0.5 * x);
    expect(curve(MATERIAL.calibration.maximumCycles, 0)).toBeLessThan(x);
    expect(curve(MATERIAL.calibration.minimumCycles, 0)).toBeGreaterThan(1.5 * x);
    const analysis = analyzeStrainStressHistory(input(history(samples([x, 3 * x, 0, 2 * x], [0, 0, 0, 0]))));
    expect(analysis.ok ? null : [analysis.code, analysis.path])
      .toEqual(['strain-life-longer-than-calibration', 'histories[0].recurrenceCycles[0]']);
  });
});
