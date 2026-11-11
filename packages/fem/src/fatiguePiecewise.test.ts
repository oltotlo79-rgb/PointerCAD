import { describe, expect, it } from 'vitest';
import { analyzeFatigue } from './fatigue.js';
import { analyzeFatiguePiecewise, FATIGUE_PIECEWISE_INPUT_SCHEMA, piecewiseEndStressMpa, type FatiguePiecewiseResult } from './fatiguePiecewise.js';

/*
 * SYNTHETIC calibration, analytically specified for these tests only. It is NOT a steel standard, detail category or
 * FAT class: two slopes 3 and 5 with a knee chosen so that every life below is a short closed-form number.
 *   segment 0: N = 1e5 * (400 / S) ** 3   for 200 <= S <= 400   (N(400) = 1e5, N(250) = 409600, N(200) = 8e5)
 *   segment 1: N = 8e5 * (200 / S) ** 5   for S_end <= S <= 200 (N(160) = 2441406.25)
 *   end: N = 1e8, S_end = 200 * (8e5 / 1e8) ** (1 / 5)
 * Each expected value is written from these formulas, independently of the implementation's segment search.
 */
const SOURCE = { kind: 'user-supplied', reference: 'synthetic test calibration (not a standard)', condition: 'unit test only' } as const;
const SEGMENTS = [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }];
const END_STRESS = 200 * (8e5 / 1e8) ** (1 / 5);

function curve(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'synthetic-two-slope', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'fully-reversed-only',
    segments: SEGMENTS, endCycles: 1e8, end: 'cutoff-at-end',
    applicability: { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' }, source: SOURCE, ...overrides };
}
/** One fully reversed period of range `range` (two half cycles, count 1 in total). */
function reversed(id: string, range: number, repeats: number): Record<string, unknown> {
  return { id, unit: 'MPa', stressMpa: [range / 2, -range / 2], sequence: 'repeated-periodic', repeats, source: SOURCE };
}
function input(curveValue: Record<string, unknown>, histories: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curveValue, histories };
}
function result(value: unknown): FatiguePiecewiseResult {
  const analysis = analyzeFatiguePiecewise(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
function relative(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}
function lifeOfOneCycle(range: number): number {
  const life = result(input(curve(), [reversed('h', range, 1)])).life;
  if (life.kind !== 'finite') throw new Error(`life ${life.kind}`);
  return life.spectrumRepetitions;
}

describe('piecewise S-N (synthetic calibration, not a standard)', () => {
  it('uses the exact life on, and on either side of, the first point (S = 400)', () => {
    expect(relative(lifeOfOneCycle(400), 1e5)).toBeLessThan(1e-12);
    expect(relative(lifeOfOneCycle(399), 1e5 * (400 / 399) ** 3)).toBeLessThan(1e-12);
    const above = analyzeFatiguePiecewise(input(curve(), [reversed('h', 401, 1)]));
    expect(above).toEqual({ ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' });
  });

  it('is continuous at the knee and uses the right slope on either side (S = 200)', () => {
    expect(relative(lifeOfOneCycle(200), 8e5)).toBeLessThan(1e-12);
    expect(relative(lifeOfOneCycle(201), 1e5 * (400 / 201) ** 3)).toBeLessThan(1e-12);
    expect(relative(lifeOfOneCycle(199), 8e5 * (200 / 199) ** 5)).toBeLessThan(1e-12);
    // The wrong slope would give these instead: 1e5*(400/199)^3 differs from 8e5*(200/199)^5 by the factor (200/199)^2, about 1 %.
    expect(relative(lifeOfOneCycle(199), 1e5 * (400 / 199) ** 3)).toBeGreaterThan(1e-3);
    expect(relative(lifeOfOneCycle(250), 409600)).toBeLessThan(1e-12);
    expect(relative(lifeOfOneCycle(160), 2441406.25)).toBeLessThan(1e-12);
  });

  it('sums Miner damage across both slopes as computed by hand', () => {
    const checked = result(input(curve(), [reversed('upper', 250, 2), reversed('lower', 160, 3)]));
    const expected = 2 / 409600 + 3 / 2441406.25; // 4.8828125e-6 + 1.2288e-6
    expect(relative(checked.damage, expected)).toBeLessThan(1e-12);
    expect(relative(checked.histories[0]?.damage ?? Number.NaN, 2 / 409600)).toBeLessThan(1e-12);
    expect(relative(checked.histories[1]?.damage ?? Number.NaN, 3 / 2441406.25)).toBeLessThan(1e-12);
    expect(checked.life.kind === 'finite' && relative(checked.life.spectrumRepetitions, 1 / expected) < 1e-12).toBe(true);
    expect(checked.method).toBe('rainflow-three-point-stack/1+miner-linear-piecewise/1');
    expect([checked.codeCompliance, checked.structuralCertification]).toEqual([false, false]);
  });

  it('applies the curve to the amplitude (half the range) when the curve is defined on amplitude', () => {
    const amplitude = result(input(curve({ stressDefinition: 'amplitude' }), [reversed('h', 250, 1)]));
    expect(relative(amplitude.damage, 1 / (8e5 * (200 / 125) ** 5))).toBeLessThan(1e-12);
  });

  it('treats the end stress as damaging and a stress just below it as cut off, or refuses it without a cut-off', () => {
    expect(relative(piecewiseEndStressMpa({ segments: SEGMENTS, endCycles: 1e8 }), END_STRESS)).toBeLessThan(1e-15);
    expect(relative(lifeOfOneCycle(END_STRESS), 1e8)).toBeLessThan(1e-12);
    const below = END_STRESS * (1 - 1e-9);
    const cut = result(input(curve(), [reversed('h', below, 1)]));
    expect([cut.damage, cut.life]).toEqual([0, { kind: 'no-damaging-cycle' }]);
    const refused = analyzeFatiguePiecewise(input(curve({ end: 'none' }), [reversed('h', below, 1)]));
    expect(refused).toEqual({ ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' });
    // A damaging cycle beside a cut-off one keeps its damage.
    const mixed = result(input(curve(), [reversed('a', below, 1), reversed('b', 250, 1)]));
    expect(relative(mixed.damage, 1 / 409600)).toBeLessThan(1e-12);
  });

  it('keeps the single-slope analysis for a one-segment curve', () => {
    const history = { id: 'h', unit: 'MPa', stressMpa: [100, -150, 50, -20, 120], sequence: 'once', repeats: 1, source: SOURCE };
    const legacy = analyzeFatigue({ schema: 'pointercad-fatigue/1', histories: [history], curve: { id: 'single', unit: 'MPa',
      stressDefinition: 'range', meanStressAssumption: 'mean-independent', referenceStressMpa: 400, referenceCycles: 1e5, slope: 3,
      cutoffStressMpa: null, source: SOURCE } });
    const piecewise = analyzeFatiguePiecewise(input(curve({ id: 'single', meanStressAssumption: 'mean-independent',
      segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }], endCycles: 1e12, end: 'none' }), [history]));
    if (!legacy.ok || !piecewise.ok) throw new Error('both analyses must succeed');
    expect(piecewise.result.histories.map(entry => entry.cycles)).toEqual(legacy.result.histories.map(entry => entry.cycles));
    expect(relative(piecewise.result.damage, legacy.result.damage)).toBeLessThan(1e-12);
    expect(piecewise.result.life.kind).toBe(legacy.result.life.kind);
  });

  it('keeps the fully-reversed-only mean assumption of the single-slope analysis', () => {
    const shifted = { id: 'h', unit: 'MPa', stressMpa: [150, -100], sequence: 'repeated-periodic', repeats: 1, source: SOURCE };
    expect(analyzeFatiguePiecewise(input(curve(), [shifted]))).toEqual({ ok: false, code: 'fatigue-mean', path: 'histories[0].cycles[0]' });
  });

  it('refuses unordered, discontinuous, mis-unit, out-of-domain and unsourced calibrations by exact code and path', () => {
    const cases: readonly [Record<string, unknown>, string, string][] = [
      [curve({ segments: [SEGMENTS[1], SEGMENTS[0]] }), 'fatigue-piecewise-order', 'curve.segments[1]'],
      [curve({ segments: [SEGMENTS[0], { fromStressMpa: 210, fromCycles: 8e5, slope: 5 }] }), 'fatigue-piecewise-continuity', 'curve.segments[1]'],
      [curve({ unit: 'kN/mm2' }), 'fatigue-unit', 'curve.unit'],
      [curve({ stressDefinition: 'peak' }), 'fatigue-curve-convention', 'curve.stressDefinition'],
      [curve({ segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 0 }] }), 'fatigue-bound', 'curve.segments[0].slope'],
      [curve({ segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: Number.NaN }] }), 'fatigue-number', 'curve.segments[0].slope'],
      [curve({ endCycles: 8e5 }), 'fatigue-bound', 'curve.endCycles'],
      [curve({ end: 'endurance' }), 'fatigue-shape', 'curve.end'],
      [curve({ source: { ...SOURCE, reference: ' ' } }), 'fatigue-source', 'curve.source'],
      [curve({ applicability: { material: 'synthetic', detail: '', scope: 'unit test only' } }), 'fatigue-applicability', 'curve.applicability.detail'],
    ];
    for (const [value, code, path] of cases) {
      expect(analyzeFatiguePiecewise(input(value, [reversed('h', 250, 1)]))).toEqual({ ok: false, code, path });
    }
    const missing = curve();
    delete missing.applicability;
    expect(analyzeFatiguePiecewise(input(missing, [reversed('h', 250, 1)]))).toEqual({ ok: false, code: 'fatigue-shape', path: 'curve' });
  });
});
