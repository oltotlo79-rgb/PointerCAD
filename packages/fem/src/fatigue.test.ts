import { describe, expect, it } from 'vitest';
import { analyzeFatigue, analyzeFatigueWithMeanStressCorrection, rainflowCycles } from './fatigue.js';
import { MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_STRESS_MPA, validateFatigueInput, type FatigueCycle, type FatigueResult } from './fatigueModel.js';
import { validateFatigueMeanStressCorrection, type FatigueCorrectedResult } from './fatigueModel.js';

/* Every expected value below is derived by hand from the stated procedure (three-point stack rainflow, closed-loop
 * counting from the first largest value for periodic histories, Miner's sum with N = Nref (Sref / S) ** m). They are
 * independently hand-derived examples, not reproductions of a standard's published example. The curve is a test-only
 * relation, not a steel fatigue strength. */
const source = { kind: 'user-supplied', reference: 'Test-only relation; not a material value', condition: 'Hand-derived example' } as const;
const curve = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'curve', unit: 'MPa',
  stressDefinition: 'range', meanStressAssumption: 'mean-independent', referenceStressMpa: 100, referenceCycles: 2e6, slope: 3,
  cutoffStressMpa: null, source, ...overrides });
const history = (id: string, stressMpa: readonly number[], sequence = 'once', repeats = 1): Record<string, unknown> =>
  ({ id, unit: 'MPa', stressMpa, sequence, repeats, source });
const input = (histories: readonly Record<string, unknown>[], curveValue = curve()): Record<string, unknown> =>
  ({ schema: 'pointercad-fatigue/1', curve: curveValue, histories });
function analyzed(value: unknown): FatigueResult {
  const analysis = analyzeFatigue(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
const rows = (cycles: readonly FatigueCycle[]) => cycles.map(cycle => [cycle.count, cycle.rangeMpa, cycle.meanMpa, cycle.fromIndex, cycle.toIndex]);
const near = (actual: number, expected: number): void => { expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12 * Math.abs(expected)); };

describe('rainflow counting (independently hand-derived)', () => {
  it('counts a nested cycle as one full cycle and the outer excursion as two half cycles', () => {
    // 0,4,1,3,0: the inner 1-3 closes (X=3 >= Y=2); then 0-4 holds the start (half); 4-0 remains (half).
    expect(rows(rainflowCycles([0, 4, 1, 3, 0], 'once'))).toEqual([[1, 2, 2, 2, 3], [0.5, 4, 2, 0, 1], [0.5, 4, 2, 1, 4]]);
  });
  it('collapses plateaus to their first sample, keeps both endpoints and leaves residual half cycles', () => {
    expect(rows(rainflowCycles([0, 0, 5, 5, 5, -5, -5, 0, 0], 'once')))
      .toEqual([[0.5, 5, 2.5, 0, 2], [0.5, 10, 0, 2, 5], [0.5, 5, -2.5, 5, 7]]);
    // Interior points that do not reverse direction are not reversals.
    expect(rows(rainflowCycles([0, 1, 2, 3], 'once'))).toEqual([[0.5, 3, 1.5, 0, 3]]);
  });
  it('finds no cycle in a constant or single-point history', () => {
    expect(rainflowCycles([7, 7, 7], 'once')).toEqual([]);
    expect(rainflowCycles([7, 7, 7], 'repeated-periodic')).toEqual([]);
    expect(rainflowCycles([5], 'once')).toEqual([]);
  });
  it('closes one period at its first largest value', () => {
    // -50,50 repeated: 50,-50,50 -> two half cycles of range 100, i.e. one full cycle per period.
    expect(rows(rainflowCycles([-50, 50], 'repeated-periodic'))).toEqual([[0.5, 100, 0, 1, 0], [0.5, 100, 0, 0, 1]]);
    // 0,4,1,3 repeated: 4,1,3,0,4 -> 1-3 full, then 4-0 and 0-4 halves.
    expect(rows(rainflowCycles([0, 4, 1, 3], 'repeated-periodic'))).toEqual([[1, 2, 2, 2, 3], [0.5, 4, 2, 1, 0], [0.5, 4, 2, 0, 1]]);
  });
  it('gives the same closed-loop cycles for a periodic history in reverse order', () => {
    const multiset = (cycles: readonly FatigueCycle[]) => cycles.map(cycle => [cycle.count, cycle.rangeMpa, cycle.meanMpa])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    expect(multiset(rainflowCycles([3, 1, 4, 0], 'repeated-periodic'))).toEqual([[0.5, 4, 2], [0.5, 4, 2], [1, 2, 2]]);
    // The forward order gives the same hand-derived multiset (its ordered rows are checked above).
    expect(multiset(rainflowCycles([0, 4, 1, 3], 'repeated-periodic'))).toEqual([[0.5, 4, 2], [0.5, 4, 2], [1, 2, 2]]);
  });
});

describe('Miner damage against an explicit single-slope relation', () => {
  const blocks = [history('a', [-50, 50], 'repeated-periodic', 1000), history('b', [-100, 100], 'repeated-periodic', 10)];
  // N(100) = 2e6, N(200) = 2e6 / 2**3 = 2.5e5: D = 1000 / 2e6 + 10 / 2.5e5 = 5.4e-4.
  const expected = 1000 / 2e6 + 10 / 2.5e5;

  it('sums two amplitude blocks to the hand-computed damage and life', () => {
    const result = analyzed(input(blocks));
    near(result.histories[0]?.damage ?? Number.NaN, 5e-4);
    near(result.histories[1]?.damage ?? Number.NaN, 4e-5);
    near(result.damage, expected);
    expect(result.life.kind).toBe('finite');
    if (result.life.kind === 'finite') near(result.life.spectrumRepetitions, 1 / expected);
    expect(result).toMatchObject({ scope: 'uniaxial-scalar-stress-history-linear-damage-estimate', codeCompliance: false,
      structuralCertification: false, stressDefinition: 'range', meanStressAssumption: 'mean-independent' });
  });

  it('uses the declared stress definition: the same curve on an amplitude axis gives the same damage', () => {
    const amplitude = analyzed(input(blocks, curve({ stressDefinition: 'amplitude', referenceStressMpa: 50 })));
    near(amplitude.damage, expected);
    // Reading the range curve as an amplitude curve halves every stress: damage / 2**3 (the factor-of-two error).
    near(analyzed(input(blocks, curve({ stressDefinition: 'amplitude' }))).damage, expected / 8);
  });

  it('applies an explicit cut-off (at or above it counts) and reports a typed no-damage life', () => {
    near(analyzed(input(blocks, curve({ cutoffStressMpa: 150 }))).damage, 4e-5);
    near(analyzed(input(blocks, curve({ cutoffStressMpa: 200 }))).damage, 4e-5);
    const none = analyzed(input(blocks, curve({ cutoffStressMpa: 250 })));
    expect(none.damage).toBe(0);
    expect(none.life).toEqual({ kind: 'no-damaging-cycle' });
    expect(JSON.stringify(none)).not.toMatch(/Infinity|NaN/u);
  });

  it('reports no damaging cycle for a constant history and a typed underflow for a vanishing range', () => {
    const constant = analyzed(input([history('flat', [0, 0, 0])]));
    expect([constant.damage, constant.life]).toEqual([0, { kind: 'no-damaging-cycle' }]);
    // A half cycle of range 1e-300 MPa: (1e-302) ** 3 underflows to 0 although the cycle is damaging.
    expect(analyzed(input([history('tiny', [0, 1e-300])])).life).toEqual({ kind: 'not-representable', reason: 'damage-underflow' });
  });

  it('scales with the stress to the power of the slope when there is no cut-off', () => {
    // 0,4,1,3,0: full range 2 and two half ranges 4 -> D = ((2/100)**3 + (4/100)**3) / 2e6 = 3.6e-11.
    const base = analyzed(input([history('nested', [0, 4, 1, 3, 0])]));
    near(base.damage, (8e-6 + 6.4e-5) / 2e6);
    const scaled = analyzed(input([history('nested', [0, 10, 2.5, 7.5, 0])]));
    near(scaled.damage, base.damage * 2.5 ** 3);
  });

  it('applies a mean-independent curve to a nonzero-mean cycle only because the user said so', () => {
    // 0 -> 100 once: one half cycle of range 100 and mean 50: D = 0.5 / 2e6.
    near(analyzed(input([history('pulse', [0, 100])])).damage, 0.25e-6);
    expect(analyzeFatigue(input([history('pulse', [0, 100])], curve({ meanStressAssumption: 'fully-reversed-only' }))))
      .toEqual({ ok: false, code: 'fatigue-mean', path: 'histories[0].cycles[0]' });
    expect(analyzeFatigue(input(blocks, curve({ meanStressAssumption: 'fully-reversed-only' }))).ok).toBe(true);
  });
});

describe('strict input contract', () => {
  const refused = (value: unknown) => {
    const analysis = analyzeFatigue(value);
    return analysis.ok ? null : [analysis.code, analysis.path];
  };
  const one = (stress: readonly number[] = [0, 1]) => [history('h', stress)];

  it('refuses an unknown or missing stress convention, mean assumption or unit', () => {
    expect(refused(input(one(), curve({ stressDefinition: 'peak' })))).toEqual(['fatigue-curve-convention', 'curve.stressDefinition']);
    expect(refused(input(one(), curve({ stressDefinition: 'Range' })))).toEqual(['fatigue-curve-convention', 'curve.stressDefinition']);
    const { stressDefinition: _omitted, ...withoutDefinition } = curve();
    expect(_omitted).toBe('range');
    expect(refused(input(one(), withoutDefinition))).toEqual(['fatigue-shape', 'curve']);
    expect(refused(input(one(), curve({ meanStressAssumption: 'goodman' })))).toEqual(['fatigue-mean-assumption', 'curve.meanStressAssumption']);
    expect(refused(input(one(), curve({ unit: 'ksi' })))).toEqual(['fatigue-unit', 'curve.unit']);
    expect(refused(input([{ ...history('h', [0, 1]), unit: 'Pa' }]))).toEqual(['fatigue-unit', 'histories[0].unit']);
  });

  it('refuses nonfinite, out-of-bound and missing curve values', () => {
    expect(refused(input(one(), curve({ slope: 0 })))).toEqual(['fatigue-bound', 'curve.slope']);
    expect(refused(input(one(), curve({ slope: Number.NaN })))).toEqual(['fatigue-number', 'curve.slope']);
    expect(refused(input(one(), curve({ referenceCycles: Number.POSITIVE_INFINITY })))).toEqual(['fatigue-number', 'curve.referenceCycles']);
    expect(refused(input(one(), curve({ referenceStressMpa: 0.5 })))).toEqual(['fatigue-bound', 'curve.referenceStressMpa']);
    expect(refused(input(one(), curve({ cutoffStressMpa: 0 })))).toEqual(['fatigue-bound', 'curve.cutoffStressMpa']);
    expect(refused(input(one(), curve({ cutoffStressMpa: undefined })))).toEqual(['fatigue-number', 'curve.cutoffStressMpa']);
    expect(refused(input(one(), curve({ source: { ...source, reference: '  ' } })))).toEqual(['fatigue-source', 'curve.source']);
  });

  it('refuses invalid histories at the exact point', () => {
    expect(refused(input(one([0, Number.NaN])))).toEqual(['fatigue-number', 'histories[0].stressMpa[1]']);
    expect(refused(input(one([0, Number.NEGATIVE_INFINITY])))).toEqual(['fatigue-number', 'histories[0].stressMpa[1]']);
    expect(refused(input(one([MAX_FATIGUE_STRESS_MPA, -MAX_FATIGUE_STRESS_MPA])))).toBeNull();
    expect(refused(input(one([0, MAX_FATIGUE_STRESS_MPA * (1 + 1e-12)])))).toEqual(['fatigue-bound', 'histories[0].stressMpa[1]']);
    expect(refused(input(one([])))).toEqual(['fatigue-history', 'histories[0].stressMpa']);
    expect(refused(input(one(new Array<number>(MAX_FATIGUE_HISTORY_POINTS + 1).fill(0))))).toEqual(['fatigue-history', 'histories[0].stressMpa']);
    // Built without delete: index 0 is a hole.
    const holes = new Array<number>(2);
    holes[1] = 1;
    expect(refused(input(one(holes)))).toEqual(['fatigue-shape', 'histories[0].stressMpa']);
    expect(refused(input([history('h', [0, 1], 'once', 2)]))).toEqual(['fatigue-repeats', 'histories[0].repeats']);
    expect(refused(input([history('h', [0, 1], 'repeated-periodic', 1.5)]))).toEqual(['fatigue-repeats', 'histories[0].repeats']);
    expect(refused(input([history('h', [0, 1], 'repeated-periodic', 0)]))).toEqual(['fatigue-repeats', 'histories[0].repeats']);
    expect(refused(input([history('h', [0, 1], 'shuffled')]))).toEqual(['fatigue-sequence', 'histories[0].sequence']);
    expect(refused(input([history('h', [0, 1]), history('h', [1, 0])]))).toEqual(['fatigue-id', 'histories[1].id']);
    expect(refused(input([]))).toEqual(['fatigue-history', 'histories']);
    expect(refused({ ...input(one()), extra: 1 })).toEqual(['fatigue-shape', '$']);
    expect(refused({ ...input(one()), schema: 'pointercad-fatigue/2' })).toEqual(['fatigue-schema', 'schema']);
  });

  it('owns fresh values: later mutation of the caller data does not change the validated input', () => {
    const stress = [0, 4, 1, 3, 0];
    const checked = validateFatigueInput(input([history('h', stress)]));
    if (!checked.ok) throw new Error(checked.code);
    stress[1] = 1000;
    expect(checked.input.histories[0]?.stressMpa).toEqual([0, 4, 1, 3, 0]);
  });
});

/** Synthetic strengths and S-N values, not properties of any named steel. The comparison values below are
 * independently derived: at mean200 and amplitude50 with UTS400, the amplitude doubles to100; N=1e6.
 * At zero/compressive mean the amplitude stays50 and N=4e6. */
const goodman = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'pointercad-fatigue-goodman/1', method: 'goodman-tension-only/1', unit: 'MPa',
  applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: 400, yieldStrengthMpa: 300,
  minimumCycles: 1001, source, ...overrides,
});
const reversedCurve = (overrides: Record<string, unknown> = {}) => curve({ stressDefinition: 'amplitude',
  meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope: 2, ...overrides });
function corrected(value: unknown, correction: unknown = goodman()): FatigueCorrectedResult {
  const outcome = analyzeFatigueWithMeanStressCorrection(value, correction);
  if (!outcome.ok) throw new Error(`${outcome.code} at ${outcome.path}`);
  return outcome.result;
}

describe('explicit elastic tensile-only Goodman correction', () => {
  it('doubles the equivalent amplitude at half UTS and retains original signed cycle identities', () => {
    const value = input([history('tension', [150, 250], 'repeated-periodic')], reversedCurve());
    const result = corrected(value);
    expect(result.histories[0]?.cycles).toEqual([
      { count: 0.5, rangeMpa: 100, meanMpa: 200, fromIndex: 1, toIndex: 0 },
      { count: 0.5, rangeMpa: 100, meanMpa: 200, fromIndex: 0, toIndex: 1 },
    ]);
    expect(result.histories[0]?.equivalentStressMpa).toEqual([100, 100]);
    near(result.damage, 1e-6);
    expect(result.life).toEqual({ kind: 'finite', spectrumRepetitions: 1e6 });
    expect(result).toMatchObject({ schema: 'pointercad-fatigue-corrected-result/1',
      method: 'rainflow-three-point-stack/1+goodman-tension-only/1+miner-linear-single-slope/1',
      meanStressAssumption: 'fully-reversed-only', correction: goodman(), codeCompliance: false, structuralCertification: false });
    // The old path still refuses this fully-reversed-only curve at nonzero mean.
    expect(analyzeFatigue(value)).toEqual({ ok: false, code: 'fatigue-mean', path: 'histories[0].cycles[0]' });
  });

  it('does not award a compressive-mean benefit and preserves its negative mean', () => {
    const result = corrected(input([history('compression', [-250, -150], 'repeated-periodic')], reversedCurve()));
    expect(result.histories[0]?.cycles.map(cycle => [cycle.count, cycle.rangeMpa, cycle.meanMpa]))
      .toEqual([[0.5, 100, -200], [0.5, 100, -200]]);
    expect(result.histories[0]?.equivalentStressMpa).toEqual([50, 50]);
    near(result.damage, 0.25e-6);
  });

  it('agrees exactly with the old zero-mean calculation without changing its result contract', () => {
    const value = input([history('zero', [-50, 50], 'repeated-periodic', 9)], reversedCurve());
    const before = analyzed(value), result = corrected(value);
    expect([result.damage, result.life, result.histories[0]?.cycles]).toEqual([before.damage, before.life, before.histories[0]?.cycles]);
    expect(before.schema).toBe('pointercad-fatigue-result/1');
    expect(Object.hasOwn(before, 'correction')).toBe(false);
    expect(Object.hasOwn(before.histories[0] ?? {}, 'equivalentStressMpa')).toBe(false);
  });

  it('uses the declared curve axis and applies the cut-off to corrected stress', () => {
    const histories = [history('pulse', [150, 250], 'repeated-periodic')];
    const amplitude = corrected(input(histories, reversedCurve({ cutoffStressMpa: 100 })));
    const range = corrected(input(histories, reversedCurve({ stressDefinition: 'range', referenceStressMpa: 200, cutoffStressMpa: 200 })));
    near(amplitude.damage, 1e-6);
    expect(range.damage).toBe(amplitude.damage);
    expect(range.histories[0]?.equivalentStressMpa).toEqual([200, 200]);
    const none = corrected(input(histories, reversedCurve({ cutoffStressMpa: 101 })));
    expect([none.damage, none.life]).toEqual([0, { kind: 'no-damaging-cycle' }]);
  });

  it('sums mixed histories, periodic repeats and chronological residual half cycles independently', () => {
    const result = corrected(input([history('up', [150, 250], 'repeated-periodic', 3),
      history('down', [-250, -150], 'repeated-periodic', 2), history('once', [-50, 50])], reversedCurve()));
    near(result.histories[0]?.damage ?? Number.NaN, 3e-6);
    near(result.histories[1]?.damage ?? Number.NaN, 0.5e-6);
    near(result.histories[2]?.damage ?? Number.NaN, 0.125e-6);
    near(result.damage, 3.625e-6);
    expect(result.histories.map(row => [row.sequence, row.repeats, row.cycles.length]))
      .toEqual([['repeated-periodic', 3, 2], ['repeated-periodic', 2, 2], ['once', 1, 1]]);
  });

  it('preserves nested-cycle counting inside a repeated history rather than correcting raw samples first', () => {
    // 200,50,150,0,200: inner50-150 full, outer0-200 two halves, both mean100.
    // Equivalent amplitudes 200/3 and400/3: lives2.25e6 and562500; nine periods give2e-5.
    const result = corrected(input([history('nested', [0, 200, 50, 150], 'repeated-periodic', 9)], reversedCurve()));
    expect(result.histories[0]?.cycles.map(cycle => [cycle.count, cycle.rangeMpa, cycle.meanMpa, cycle.fromIndex, cycle.toIndex]))
      .toEqual([[1, 100, 100, 2, 3], [0.5, 200, 100, 1, 0], [0.5, 200, 100, 0, 1]]);
    near(result.damage, 2e-5);
  });

  it('keeps constant histories and subnormal positive ranges as distinct no-damage/underflow outcomes', () => {
    const flat = corrected(input([history('flat', [200, 200])], reversedCurve()));
    expect([flat.damage, flat.life, flat.histories[0]?.equivalentStressMpa]).toEqual([0, { kind: 'no-damaging-cycle' }, []]);
    const tiny = corrected(input([history('tiny', [0, Number.MIN_VALUE])], reversedCurve({ stressDefinition: 'range' })));
    expect(tiny.histories[0]?.equivalentStressMpa).toEqual([Number.MIN_VALUE]);
    expect(tiny.life).toEqual({ kind: 'not-representable', reason: 'damage-underflow' });
    expect(JSON.stringify(tiny)).not.toMatch(/Infinity|NaN/u);
  });

  it('owns correction provenance and does not mutate frozen input or material data', () => {
    const mutableSource = { ...source, reference: String(source.reference) }, correction = goodman({ source: mutableSource });
    const checked = validateFatigueMeanStressCorrection(correction);
    if (!checked.ok) throw new Error(checked.code);
    mutableSource.reference = 'changed after validation';
    correction.yieldStrengthMpa = 1;
    expect(checked.correction.yieldStrengthMpa).toBe(300);
    expect(checked.correction.source.reference).toBe(source.reference);
    const points = Object.freeze([150, 250]), row = Object.freeze(history('frozen', points, 'repeated-periodic'));
    const value = Object.freeze(input(Object.freeze([row]), Object.freeze(reversedCurve())));
    const material = Object.freeze(goodman({ source: Object.freeze({ ...source }) }));
    const before = JSON.stringify([value, material]);
    corrected(value, material);
    expect(JSON.stringify([value, material])).toBe(before);
  });
});

describe('Goodman contract and domain refusals', () => {
  const problem = (points: readonly number[] = [150, 250], overrides: Record<string, unknown> = {}) =>
    input([history('h', points, 'repeated-periodic')], reversedCurve(overrides));
  const refusal = (correction: unknown, value: unknown = problem()) => {
    const outcome = analyzeFatigueWithMeanStressCorrection(value, correction);
    return outcome.ok ? null : [outcome.code, outcome.path];
  };
  it.each([
    ['missing', null, 'fatigue-shape', 'correction'],
    ['extra', goodman({ guessedGrade: 'steel' }), 'fatigue-shape', 'correction'],
    ['schema', goodman({ schema: 'pointercad-fatigue-goodman/2' }), 'fatigue-correction-schema', 'correction.schema'],
    ['method', goodman({ method: 'gerber' }), 'fatigue-correction-method', 'correction.method'],
    ['applicability', goodman({ applicability: 'multiaxial' }), 'fatigue-correction-method', 'correction.method'],
    ['unit', goodman({ unit: 'Pa' }), 'fatigue-unit', 'correction.unit'],
    ['coercion', goodman({ ultimateTensileStrengthMpa: '400' }), 'fatigue-number', 'correction.ultimateTensileStrengthMpa'],
    ['nonfinite', goodman({ yieldStrengthMpa: Number.NaN }), 'fatigue-number', 'correction.yieldStrengthMpa'],
    ['zero', goodman({ ultimateTensileStrengthMpa: 0 }), 'fatigue-correction-strength', 'correction.ultimateTensileStrengthMpa'],
    ['negative', goodman({ yieldStrengthMpa: -300 }), 'fatigue-correction-strength', 'correction.yieldStrengthMpa'],
    ['unbounded', goodman({ ultimateTensileStrengthMpa: 10001 }), 'fatigue-correction-strength', 'correction.ultimateTensileStrengthMpa'],
    ['ordering', goodman({ yieldStrengthMpa: 401 }), 'fatigue-correction-strength', 'correction.yieldStrengthMpa'],
    ['low cycle', goodman({ minimumCycles: 1000 }), 'fatigue-correction-domain', 'correction.minimumCycles'],
    ['nonfinite life', goodman({ minimumCycles: Number.POSITIVE_INFINITY }), 'fatigue-number', 'correction.minimumCycles'],
    ['source', goodman({ source: { ...source, reference: '' } }), 'fatigue-source', 'correction.source'],
  ])('refuses %s without substituting a material or method', (_label, correction, code, path) => {
    expect(refusal(correction)).toEqual([code, path]);
  });

  it('requires an explicitly fully reversed curve and preserves strict legacy schema handling', () => {
    expect(refusal(goodman(), problem([150, 250], { meanStressAssumption: 'mean-independent' })))
      .toEqual(['fatigue-correction-curve', 'curve.meanStressAssumption']);
    expect(refusal(goodman(), { ...problem(), correction: goodman() })).toEqual(['fatigue-shape', '$']);
    expect(refusal(goodman(), { ...problem(), schema: 'pointercad-fatigue/2' })).toEqual(['fatigue-schema', 'schema']);
    expect(analyzeFatigue({ ...problem(), correction: goodman() })).toEqual({ ok: false, code: 'fatigue-shape', path: '$' });
  });

  it.each([300, -300, 400, -400])('refuses actual stress at/outside symmetric yield, including constant %s MPa', stress => {
    expect(refusal(goodman(), problem([stress])))
      .toEqual(['fatigue-correction-domain', 'histories[0].stressMpa[0]']);
  });

  it('accepts a stated S-N life limit at equality and refuses extrapolation below it', () => {
    expect(refusal(goodman(), problem([150, 250], { referenceCycles: 1001 }))).toBeNull();
    expect(refusal(goodman(), problem([150, 250], { referenceCycles: 1000 })))
      .toEqual(['fatigue-correction-domain', 'histories[0].cycles[0]']);
    // An explicit endurance cut-off gives no damage, rather than extrapolating the sloping branch below it.
    expect(corrected(problem([150, 250], { referenceCycles: 1, cutoffStressMpa: 101 })).life)
      .toEqual({ kind: 'no-damaging-cycle' });
  });
});

/* The life is how many times the whole input could be applied until damage 1. A 'once' record can occur again only
 * after its stress has returned to its first value, so the cycles of a recurrence are the closed-loop cycles of the
 * record, not its residual half cycles. Every value below is hand-derived from N = Nref (Sref / S) ** m with the test
 * curve of this file (range axis, Sref 100 MPa, Nref 2e6, m 3: N(100) = 2e6, N(200) = 2.5e5); none is read back from a
 * run. Before the correction the life was 1 / (single-pass damage): 4e6 for 0 -> 100 and 3.2e6 for 50,100,0,50. */
describe('life of a repeated input that contains a one-time record (independently hand-derived)', () => {
  const life = (result: { readonly life: FatigueResult['life'] }): number =>
    result.life.kind === 'finite' ? result.life.spectrumRepetitions : Number.NaN;

  it('0 -> 100 once: one pass is half a cycle, each recurrence adds a full cycle of range 100', () => {
    const result = analyzed(input([history('pulse', [0, 100])]));
    expect(rows(result.histories[0]?.cycles ?? [])).toEqual([[0.5, 100, 50, 0, 1]]);
    near(result.damage, 0.5 / 2e6);
    // Applied k times: 0,100,0,100,...,0,100 -> one full cycle of range 100 per application, so 2e6 applications.
    expect(result.life.kind).toBe('finite');
    near(life(result), 2e6);
  });

  it('50,100,0,50 once: the record closes on itself, yet its single-pass halves understate a recurrence', () => {
    const result = analyzed(input([history('closed', [50, 100, 0, 50])]));
    // Halves 50 -> 100 (mean 75), 100 -> 0 (mean 50), 0 -> 50 (mean 25): D = 0.5 (0.125 + 1 + 0.125) / 2e6.
    expect(rows(result.histories[0]?.cycles ?? [])).toEqual([[0.5, 50, 75, 0, 1], [0.5, 100, 50, 1, 2], [0.5, 50, 25, 2, 3]]);
    near(result.damage, 0.625 / 2e6);
    // Repeated, 50,100,0,50,100,0,...: the 50s are not reversals; one full cycle 0 <-> 100 per application.
    near(life(result), 2e6);
  });

  it('keeps the life where the halves already form the recurring cycle, and sums periodic blocks unchanged', () => {
    // 0,200,0 once: halves 0 -> 200 and 200 -> 0 are exactly one full cycle of range 200: D = 1 / 2.5e5.
    const closed = analyzed(input([history('up-down', [0, 200, 0])]));
    near(closed.damage, 1 / 2.5e5);
    near(life(closed), 2.5e5);
    // 1000 periods of -50,50 (one full cycle of range 100 each) plus 0 -> 100 once.
    const mixed = analyzed(input([history('a', [-50, 50], 'repeated-periodic', 1000), history('pulse', [0, 100])]));
    near(mixed.damage, (1000 + 0.5) / 2e6);
    near(life(mixed), 2e6 / 1001);
  });

  it('applies the curve applicability and the cut-off to the recurring cycles as well', () => {
    // -50 -> 50 once is fully reversed in one pass and when it recurs: D = 0.5 / 2e6, life 2e6.
    const reversed = analyzed(input([history('swing', [-50, 50])], curve({ meanStressAssumption: 'fully-reversed-only' })));
    near(reversed.damage, 0.5 / 2e6);
    near(life(reversed), 2e6);
    // A cut-off of 150 MPa above the only range (100) leaves no damaging cycle in a pass or in a recurrence.
    const none = analyzed(input([history('pulse', [0, 100])], curve({ cutoffStressMpa: 150 })));
    expect([none.damage, none.life]).toEqual([0, { kind: 'no-damaging-cycle' }]);
  });

  it('Goodman: 150 -> 250 once is half a corrected cycle per pass and a full one per recurrence', () => {
    // Mean 200, amplitude 50, UTS 400: equivalent amplitude 100, N = 1e6 on the reversed test curve.
    const result = corrected(input([history('tension', [150, 250])], reversedCurve()));
    expect(result.histories[0]?.cycles).toEqual([{ count: 0.5, rangeMpa: 100, meanMpa: 200, fromIndex: 0, toIndex: 1 }]);
    expect(result.histories[0]?.equivalentStressMpa).toEqual([100]);
    near(result.damage, 0.5e-6);
    near(life(result), 1e6);
  });
});
