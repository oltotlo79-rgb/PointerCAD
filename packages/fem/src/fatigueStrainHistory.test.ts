import { describe, expect, it } from 'vitest';
import { MAX_STRAIN_HISTORY_ABS_STRAIN, analyzeStrainHistory, validateStrainHistoryInput, type StrainHistoryCycle,
  type StrainHistoryResult } from './fatigueStrainHistory.js';
import { MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS } from './fatigueModel.js';

/* Manufactured, test-only coefficients (not SS400, S45C or any real material): b = c = -0.5 and
 * A + B = 1000 / 200000 + 0.995 = 1, so a cycle of strain amplitude a lives 2N = a ** -2 reversals, N = 1 / (2 a ** 2)
 * cycles, and damages 2 a ** 2 per full cycle and a ** 2 per half cycle. Every expected damage below uses only this
 * closed form and rainflow cycles counted by hand in the comments, never the production solver. Strains are multiples
 * of u = 2 ** -8 so that every range, mean and amplitude is exact in binary. */
const source = { kind: 'user-supplied', reference: 'Test-only manufactured coefficients; not a material value',
  condition: 'Hand-derived example' } as const;
const material = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured',
  stressUnit: 'MPa', elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration: { minimumCycles: 1, maximumCycles: 1e6 },
  source, ...overrides });
const u = 2 ** -8;
const perCycle = (amplitude: number): number => 2 * amplitude ** 2;
const history = (id: string, strain: unknown, sequence: unknown = 'once', repeats: unknown = 1,
  overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ id, strainMeasure: 'local-total-strain',
  strainUnit: 'dimensionless', derivation: 'measured', strain, sequence, repeats, source, ...overrides });
const input = (histories: unknown, mat: unknown = material(), meanStress: unknown = 'assumed-zero'): Record<string, unknown> =>
  ({ schema: 'pointercad-strain-history/1', meanStress, material: mat, histories });
function analyzed(value: unknown): StrainHistoryResult {
  const analysis = analyzeStrainHistory(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
const refusal = (value: unknown): readonly [string, string] => {
  const analysis = analyzeStrainHistory(value);
  return analysis.ok ? ['accepted', ''] : [analysis.code, analysis.path];
};
const near = (actual: number, expected: number, relative = 1e-9): void => {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(relative * Math.abs(expected));
};
const rows = (cycles: readonly StrainHistoryCycle[]) =>
  cycles.map(cycle => [cycle.count, cycle.strainRange, cycle.meanStrain, cycle.fromIndex, cycle.toIndex]);
const finiteLife = (result: StrainHistoryResult): number => {
  if (result.life.kind !== 'finite') throw new Error(`life ${result.life.kind}`);
  return result.life.spectrumRepetitions;
};

describe('constant-amplitude blocks (closed form)', () => {
  it('counts one full cycle per period and multiplies by the repeats', () => {
    // -2u, 2u repeated: two half cycles of range 4u (amplitude 2u, N = 1 / (8 u ** 2) = 8192) per period.
    const result = analyzed(input([history('block', [-2 * u, 2 * u], 'repeated-periodic', 1000)]));
    const entry = result.histories[0];
    if (entry === undefined) throw new Error('one history expected');
    expect(rows(entry.cycles)).toEqual([[0.5, 4 * u, 0, 1, 0], [0.5, 4 * u, 0, 0, 1]]);
    near(entry.cycles[0]?.cyclesToFailure ?? Number.NaN, 8192);
    near(result.damage, 1000 * perCycle(2 * u));
    near(finiteLife(result), 8.192);
  });
  it('treats a once history as half cycles and the same periodic history as full cycles', () => {
    near(analyzed(input([history('once', [-2 * u, 2 * u])])).damage, 0.5 * perCycle(2 * u));
    near(analyzed(input([history('period', [-2 * u, 2 * u], 'repeated-periodic', 1)])).damage, perCycle(2 * u));
  });
  it('sums Miner damage over histories of different amplitudes', () => {
    // 100 x 8 u ** 2 + 400 x 2 u ** 2 = 1600 u ** 2 = 0.0244140625, so the input can be applied 40.96 times.
    const result = analyzed(input([history('large', [-2 * u, 2 * u], 'repeated-periodic', 100),
      history('small', [-u, u], 'repeated-periodic', 400)]));
    near(result.histories[0]?.damage ?? Number.NaN, 100 * perCycle(2 * u));
    near(result.histories[1]?.damage ?? Number.NaN, 400 * perCycle(u));
    near(result.damage, 1600 * u ** 2);
    near(finiteLife(result), 40.96);
  });
  it('scales the damage of a period exactly by its repeats', () => {
    const once = analyzed(input([history('p', [0, 4 * u, u, 3 * u], 'repeated-periodic', 1)])).damage;
    expect(analyzed(input([history('p', [0, 4 * u, u, 3 * u], 'repeated-periodic', 7)])).damage).toBe(once * 7);
  });
});

describe('rainflow handling of strain reversals (hand-counted)', () => {
  it('counts half cycles of a once history with their signed mean strain and plateau indices', () => {
    // 0, 2u, -2u, 2u, -2u, 0 -> halves (0,2u), (2u,-2u), (-2u,2u), then residual (2u,-2u), (-2u,0):
    // two halves of amplitude u and three of amplitude 2u: 2 u ** 2 + 12 u ** 2 = 14 u ** 2.
    const result = analyzed(input([history('h', [0, 2 * u, -2 * u, 2 * u, -2 * u, 0])]));
    expect(rows(result.histories[0]?.cycles ?? [])).toEqual([[0.5, 2 * u, u, 0, 1], [0.5, 4 * u, 0, 1, 2],
      [0.5, 4 * u, 0, 2, 3], [0.5, 4 * u, 0, 3, 4], [0.5, 2 * u, -u, 4, 5]]);
    near(result.damage, 14 * u ** 2);
  });
  it('closes a nested periodic history: inner full cycle plus the outer range once per period', () => {
    // 0, 4u, u, 3u repeated -> 4u, u, 3u, 0, 4u: (u, 3u) full (amplitude u), then (4u, 0) and (0, 4u) halves
    // (amplitude 2u): 2 u ** 2 + 8 u ** 2 = 10 u ** 2 per period.
    const result = analyzed(input([history('nested', [0, 4 * u, u, 3 * u], 'repeated-periodic', 1)]));
    expect((result.histories[0]?.cycles ?? []).map(cycle => [cycle.count, cycle.strainAmplitude]))
      .toEqual([[1, u], [0.5, 2 * u], [0.5, 2 * u]]);
    near(result.damage, 10 * u ** 2);
  });
  it('collapses plateaus and ignores non-reversing interior points', () => {
    // 0, 0, 2u, 2u, u, 0: plateaus collapse to 0, 2u, u, 0; u is not a reversal -> halves (0,2u) and (2u,0).
    const result = analyzed(input([history('plateau', [0, 0, 2 * u, 2 * u, u, 0])]));
    expect(rows(result.histories[0]?.cycles ?? [])).toEqual([[0.5, 2 * u, u, 0, 2], [0.5, 2 * u, u, 2, 5]]);
    expect(result.histories[0]?.reversals).toBe(3);
  });
  it('uses the strain range only: a nonzero mean strain is reported but not turned into a mean stress', () => {
    const shifted = analyzed(input([history('shifted', [u, 5 * u], 'repeated-periodic', 1)]));
    const centred = analyzed(input([history('centred', [-2 * u, 2 * u], 'repeated-periodic', 1)]));
    expect(shifted.damage).toBe(centred.damage);
    expect(shifted.histories[0]?.cycles.map(cycle => cycle.meanStrain)).toEqual([3 * u, 3 * u]);
    expect(shifted.meanStress).toBe('assumed-zero');
  });
  it('accepts the largest history and counts every alternating range as a half cycle', () => {
    // n alternating points of a once history give n - 1 half cycles of the same range.
    const strain = Array.from({ length: MAX_FATIGUE_HISTORY_POINTS }, (_, index) => (index % 2 === 0 ? -2 * u : 2 * u));
    const result = analyzed(input([history('long', strain)]));
    expect(result.histories[0]?.cycles.length).toBe(MAX_FATIGUE_HISTORY_POINTS - 1);
    near(result.damage, (MAX_FATIGUE_HISTORY_POINTS - 1) * 0.5 * perCycle(2 * u));
  });
});

describe('cycles without a verified life', () => {
  it('reports no cycle explicitly instead of an infinite life or zero damage as a verified result', () => {
    for (const strain of [[3 * u, 3 * u, 3 * u], [u]]) {
      for (const sequence of ['once', 'repeated-periodic']) {
        const result = analyzed(input([history('flat', strain, sequence)]));
        expect([result.life, result.damage, result.histories[0]?.cycles]).toEqual([{ kind: 'no-strain-cycle' }, 0, []]);
      }
    }
  });
  it('takes the life from the other histories when one history has no cycle', () => {
    const result = analyzed(input([history('flat', [u, u]), history('block', [-2 * u, 2 * u], 'repeated-periodic', 1)]));
    expect(result.histories[0]?.damage).toBe(0);
    near(finiteLife(result), 8192);
  });
  it('refuses the whole analysis at the first cycle outside the calibrated interval, after damaging cycles', () => {
    const block = history('block', [-2 * u, 2 * u], 'repeated-periodic', 1);
    // Amplitude 2 ** -15 is below the curve at 2e6 reversals (2e6 ** -0.5 > 7e-4): longer than calibrated.
    expect(refusal(input([block, history('tiny', [0, 2 ** -14])])))
      .toEqual(['strain-life-longer-than-calibration', 'histories[1].cycles[0]']);
    // Amplitude 0.75 is above the curve at 2 reversals (2 ** -0.5 < 0.71): shorter than calibrated.
    expect(refusal(input([block, history('large', [-0.75, 0.75])])))
      .toEqual(['strain-life-shorter-than-calibration', 'histories[1].cycles[0]']);
  });
  it('names the refused cycle inside a history', () => {
    // Calibrated from 1e4 cycles: amplitude u lives 32768 cycles (inside), amplitude 2u lives 8192 (outside).
    const narrow = material({ calibration: { minimumCycles: 10_000, maximumCycles: 1e6 } });
    expect(refusal(input([history('h', [0, 2 * u, -2 * u, 2 * u, -2 * u, 0])], narrow)))
      .toEqual(['strain-life-shorter-than-calibration', 'histories[0].cycles[1]']);
  });
});

describe('mean-stress assumption and material contract', () => {
  it('refuses Morrow (no validated stress at each reversal) and any unstated assumption', () => {
    const histories = [history('block', [-2 * u, 2 * u], 'repeated-periodic', 1)];
    expect(refusal(input(histories, material(), 'morrow'))).toEqual(['strain-history-mean-unsupported', 'meanStress']);
    expect(refusal(input(histories, material(), 'none'))).toEqual(['strain-history-mean-assumption', 'meanStress']);
    // An own meanStress key holding undefined: passing undefined to input() would take its 'assumed-zero' default.
    const unstated = { ...input(histories), meanStress: undefined };
    expect(Object.hasOwn(unstated, 'meanStress') && unstated.meanStress === undefined).toBe(true);
    expect(refusal(unstated)).toEqual(['strain-history-mean-assumption', 'meanStress']);
  });
  it('keeps the strain-life refusal code and path for the material', () => {
    const histories = [history('block', [-2 * u, 2 * u])];
    expect(refusal(input(histories, material({ elasticModulusMpa: 206 })))).toEqual(['strain-life-bound', 'material.elasticModulusMpa']);
    expect(refusal(input(histories, null))).toEqual(['strain-life-shape', 'material']);
    expect(refusal(input(histories, material({ calibration: { minimumCycles: 10, maximumCycles: 1 } }))))
      .toEqual(['strain-life-calibration', 'material.calibration.maximumCycles']);
    expect(refusal(input(histories, material({ fatigueStrengthExponent: 0.1 })))).toEqual(['strain-life-sign', 'material.fatigueStrengthExponent']);
  });
});

describe('result contract', () => {
  it('reports the scope without certification and serializes without loss', () => {
    const result = analyzed(input([history('block', [-2 * u, 2 * u], 'repeated-periodic', 3)]));
    expect(result).toMatchObject({ schema: 'pointercad-strain-history-result/1',
      method: 'rainflow-three-point-stack/1+basquin-coffin-manson/1+miner-linear/1',
      scope: 'uniaxial-local-total-strain-history-linear-damage-estimate', meanStress: 'assumed-zero',
      codeCompliance: false, structuralCertification: false, materialId: 'manufactured',
      calibration: { minimumCycles: 1, maximumCycles: 1e6 } });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('copies the input so later caller mutation cannot change a validated value', () => {
    const strain = [-2 * u, 2 * u];
    const checked = validateStrainHistoryInput(input([history('block', strain)]));
    if (!checked.ok) throw new Error(checked.code);
    strain[1] = 0;
    expect(checked.input.histories[0]?.strain).toEqual([-2 * u, 2 * u]);
  });
  it('accepts a strain of magnitude exactly 1 and refuses anything larger', () => {
    expect(validateStrainHistoryInput(input([history('h', [0, MAX_STRAIN_HISTORY_ABS_STRAIN])])).ok).toBe(true);
    expect(refusal(input([history('h', [0, -1.000000001])]))).toEqual(['strain-history-bound', 'histories[0].strain[1]']);
  });
});

describe('malformed and oversized input (typed refusals, never a thrown error)', () => {
  const valid = (id = 'h'): Record<string, unknown> => history(id, [-2 * u, 2 * u]);
  const tooMany = Array.from({ length: MAX_FATIGUE_HISTORIES + 1 }, (_, index) => valid(`h${index}`));
  const tooLong = Array.from({ length: MAX_FATIGUE_HISTORY_POINTS + 1 }, () => 0);
  const cases: [string, unknown, string, string][] = [
    ['null', null, 'strain-history-shape', '$'],
    ['missing mean assumption', { schema: 'pointercad-strain-history/1', material: material(), histories: [valid()] },
      'strain-history-shape', '$'],
    ['schema', { ...input([valid()]), schema: 'pointercad-strain-history/2' }, 'strain-history-schema', 'schema'],
    ['histories not an array', input({}), 'strain-history-shape', 'histories'],
    ['histories with a hole', input(new Array(1)), 'strain-history-shape', 'histories'],
    ['no history', input([]), 'strain-history-length', 'histories'],
    ['too many histories', input(tooMany), 'strain-history-length', 'histories'],
    ['extra history key', input([{ ...valid(), stressMpa: [0, 1] }]), 'strain-history-shape', 'histories[0]'],
    ['history id', input([history('', [0, u])]), 'strain-history-id', 'histories[0].id'],
    ['duplicate id', input([valid('same'), valid('same')]), 'strain-history-id', 'histories[1].id'],
    ['elastic stress as strain', input([history('h', [0, u], 'once', 1, { strainMeasure: 'elastic-stress-over-modulus' })]),
      'strain-history-strain-measure', 'histories[0].strainMeasure'],
    ['linear-elastic derivation', input([history('h', [0, u], 'once', 1, { derivation: 'linear-elastic' })]),
      'strain-history-strain-measure', 'histories[0].derivation'],
    ['microstrain unit', input([history('h', [0, u], 'once', 1, { strainUnit: 'microstrain' })]),
      'strain-history-unit', 'histories[0].strainUnit'],
    ['empty strain', input([history('h', [])]), 'strain-history-length', 'histories[0].strain'],
    ['too long strain', input([history('h', tooLong)]), 'strain-history-length', 'histories[0].strain'],
    ['strain with a hole', input([history('h', new Array(2))]), 'strain-history-shape', 'histories[0].strain'],
    ['strain not an array', input([history('h', 0.001)]), 'strain-history-shape', 'histories[0].strain'],
    ['strain NaN', input([history('h', [0, Number.NaN])]), 'strain-history-number', 'histories[0].strain[1]'],
    ['strain text', input([history('h', [0, '0.001'])]), 'strain-history-number', 'histories[0].strain[1]'],
    ['strain in microstrain', input([history('h', [0, 1500])]), 'strain-history-bound', 'histories[0].strain[1]'],
    ['sequence', input([history('h', [0, u], 'twice')]), 'strain-history-sequence', 'histories[0].sequence'],
    ['once repeated', input([history('h', [0, u], 'once', 2)]), 'strain-history-repeats', 'histories[0].repeats'],
    ['zero repeats', input([history('h', [0, u], 'repeated-periodic', 0)]), 'strain-history-repeats', 'histories[0].repeats'],
    ['fractional repeats', input([history('h', [0, u], 'repeated-periodic', 1.5)]), 'strain-history-repeats', 'histories[0].repeats'],
    ['too many repeats', input([history('h', [0, u], 'repeated-periodic', 1e9 + 1)]), 'strain-history-repeats', 'histories[0].repeats'],
    ['source blank', input([history('h', [0, u], 'once', 1, { source: { ...source, reference: ' ' } })]),
      'strain-history-source', 'histories[0].source'],
    ['source shape', input([history('h', [0, u], 'once', 1, { source: 'test' })]), 'strain-history-shape', 'histories[0].source'],
  ];
  it.each(cases)('%s', (_name, value, code, path) => {
    expect(refusal(value)).toEqual([code, path]);
    const checked = validateStrainHistoryInput(value);
    expect(checked.ok ? ['accepted', ''] : [checked.code, checked.path]).toEqual([code, path]);
  });
});

/* Life of a repeated input with a one-time record, hand-counted with the closed form above (a full cycle of amplitude a
 * damages 2 a ** 2, a half cycle a ** 2). A 'once' record can occur again only after its strain has returned to its first
 * value, so a recurrence is counted closed-loop while the single pass keeps its half cycles. Before the correction the
 * life was 1 / (single-pass damage): 65536 for 0 -> 2u and 1 / (4.25 u ** 2) for u, 3u, 0, 2u. */
describe('life of a repeated input that contains a one-time record (hand-counted)', () => {
  it('0 -> 2u once: half a cycle per pass, one full cycle of amplitude u per recurrence', () => {
    const result = analyzed(input([history('pulse', [0, 2 * u])]));
    expect(rows(result.histories[0]?.cycles ?? [])).toEqual([[0.5, 2 * u, u, 0, 1]]);
    near(result.damage, u ** 2);
    // Recurring 0, 2u, 0, 2u, ...: one full cycle of amplitude u, 2 u ** 2 per application, so 2 ** 15 applications.
    near(finiteLife(result), 32768);
  });

  it('u, 3u, 0, 2u once: the recurrence closes 2u -> u into a new small cycle and pairs the large halves', () => {
    // Single pass: halves (u, 3u) amplitude u, (3u, 0) amplitude 1.5u, (0, 2u) amplitude u: (1 + 2.25 + 1) u ** 2.
    const result = analyzed(input([history('ramp', [u, 3 * u, 0, 2 * u])]));
    expect(rows(result.histories[0]?.cycles ?? [])).toEqual([[0.5, 2 * u, 2 * u, 0, 1], [0.5, 3 * u, 1.5 * u, 1, 2],
      [0.5, 2 * u, u, 2, 3]]);
    near(result.damage, 4.25 * u ** 2);
    // Recurring 3u, 0, 2u, u, 3u: full (2u, u) of amplitude 0.5u (0.5 u ** 2) and halves (3u, 0), (0, 3u) of amplitude
    // 1.5u (2.25 u ** 2 each): 5 u ** 2 per application. The same record stated periodic counts the same cycles.
    near(finiteLife(result), 1 / (5 * u ** 2));
    near(analyzed(input([history('ramp', [u, 3 * u, 0, 2 * u], 'repeated-periodic', 1)])).damage, 5 * u ** 2);
  });

  it('refuses a recurring cycle outside the calibrated interval, named as a recurrence cycle', () => {
    // Up to 1e5 cycles: amplitudes u (32768 cycles) and 1.5u (65536 / 4.5 cycles) of the single pass are inside, the
    // recurring amplitude 0.5u lives 2 / u ** 2 = 131072 cycles: longer than calibrated.
    const narrow = material({ calibration: { minimumCycles: 1, maximumCycles: 1e5 } });
    expect(refusal(input([history('ramp', [u, 3 * u, 0, 2 * u])], narrow)))
      .toEqual(['strain-life-longer-than-calibration', 'histories[0].recurrenceCycles[0]']);
    expect(refusal(input([history('ramp', [u, 3 * u, 0, 2 * u], 'repeated-periodic', 1)], narrow)))
      .toEqual(['strain-life-longer-than-calibration', 'histories[0].cycles[0]']);
  });

  it('keeps the life of a record whose single-pass halves already form the recurring cycle', () => {
    // 0, 2u, 0: halves (0, 2u) and (2u, 0) of amplitude u are one full cycle: 2 u ** 2 per pass and per recurrence.
    const result = analyzed(input([history('up-down', [0, 2 * u, 0])]));
    near(result.damage, 2 * u ** 2);
    near(finiteLife(result), 32768);
    // A periodic block beside it is unchanged: 1000 x 8 u ** 2 + 2 u ** 2 = 8002 u ** 2 per application.
    near(finiteLife(analyzed(input([history('block', [-2 * u, 2 * u], 'repeated-periodic', 1000),
      history('up-down', [0, 2 * u, 0])]))), 1 / (8002 * u ** 2));
  });
});
