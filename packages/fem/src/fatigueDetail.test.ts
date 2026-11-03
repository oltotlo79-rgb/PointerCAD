import { describe, expect, it } from 'vitest';
import { analyzeFatigueDetail, FATIGUE_DETAIL_INPUT_SCHEMA, fatigueDetailAreaMm2, validateFatigueDetailInput,
  type FatigueDetailResult } from './fatigueDetail.js';

/*
 * Expected values are written from the published formulas and tables below, independently of the implementation.
 * The S-N constants are TEST calibrations copied from a published recommended practice, not product defaults.
 *
 * [DNV] DNV-RP-C203 (August 2005, amended October 2006), https://rules.dnv.com/docs/pdf/dnvpm/codes/docs/2006-10/RP-C203.pdf:
 *   2.4.1 log N = log a - m log(Delta sigma); Table 2-1 (air): N <= 1e7 cycles m1 = 3, N > 1e7 cycles m2 = 5,
 *     F1: log a1 = 11.699, log a2 = 14.832, fatigue limit at 1e7 cycles 36.84 MPa;
 *     E:  log a1 = 12.010, log a2 = 15.350, fatigue limit at 1e7 cycles 46.78 MPa. Stress ranges in MPa.
 *   Table A-2 detail 3: bolts and threaded rods in tension, stress on the tensile stress area; F1 for cold rolled threads.
 *     For preloaded bolts the stress range depends on the preload and the geometry of the connection (not inferred here).
 *   Table A-8 details 6 and 7 (category E): fillet welds transmitting shear / fillet welded lap joint, stress range from
 *     the weld throat area considering the total length of the weld.
 *   Thickness effect (2.4.3): t = tref for t < tref = 25 mm, so no correction for the M20 bolt and the plates assumed here.
 * [ISO] Tensile stress area As = 0.7854 ((d2 + d3) / 2)^2 (Fastenal, Mechanical Properties per ISO 898-1, Rev 3-6-09,
 *   page 2, "Metric Thread Stress Areas", with its table of As in mm2,
 *   https://crafter.fastenal.com/static-assets/pdfs/Mechanical_Properties_of_Metric_Fasteners.pdf);
 *   (d2 + d3) / 2 = d - 0.938194 P for ISO metric threads.
 */
const DNV_SOURCE = { kind: 'user-supplied', reference: 'DNV-RP-C203 (2005, amended 2006) Table 2-1, air',
  condition: 'unit test calibration copied from the recommended practice; not a product default' } as const;
const LOAD_SOURCE = { kind: 'user-supplied', reference: 'hand-written test history', condition: 'unit test only' } as const;
const ISO_STRESS_DIAMETER_PITCH = 0.938194;

/** Stress at which log N = logA - m log S reaches `cycles`. */
const stressAt = (logA: number, slope: number, cycles: number): number => (10 ** logA / cycles) ** (1 / slope);
/** Two-slope DNV air curve (m = 3 then 5, knee at 1e7) as a piecewise calibration from 1e5 to 1e8 cycles. */
function dnvCurve(id: string, logA1: number, detailStress: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { detailStress, calibration: { id, unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
    segments: [{ fromStressMpa: stressAt(logA1, 3, 1e5), fromCycles: 1e5, slope: 3 },
      { fromStressMpa: stressAt(logA1, 3, 1e7), fromCycles: 1e7, slope: 5 }],
    endCycles: 1e8, end: 'none',
    applicability: { material: 'structural steel in air (DNV-RP-C203)', detail: id, scope: 'unit test only' },
    source: DNV_SOURCE, ...overrides } };
}
const F1_TENSILE_AREA = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  dnvCurve('DNV F1 bolt cold rolled thread', 11.699, 'bolt-axial-normal-tensile-stress-area', overrides);
const E_WELD_THROAT = (overrides: Record<string, unknown> = {}): Record<string, unknown> =>
  dnvCurve('DNV E fillet weld throat shear', 12.010, 'weld-fillet-throat-nominal-shear', overrides);

function m20Bolt(geometry: Record<string, unknown> = { kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm: 20, pitchMm: 2.5 }):
  Record<string, unknown> {
  return { id: 'B1', kind: 'bolt', method: 'bolt-axial-nominal/1', geometry };
}
function lapWeld(geometry: Record<string, unknown> = { kind: 'fillet-throat-area', throatMm: 5, effectiveLengthMm: 100, lines: 2 }):
  Record<string, unknown> {
  return { id: 'W1', kind: 'weld', method: 'fillet-weld-nominal-shear/1', loadPath: 'concentric-in-plane-shear', geometry };
}
function forceHistory(forceN: readonly number[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'h', unit: 'N', forceN, sequence: 'repeated-periodic', repeats: 1, source: LOAD_SOURCE, ...overrides };
}
function forceLoading(detailId: string, quantity: string, histories: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { detailId, location: 'user joint analysis, test fixture', quantity, histories };
}
function input(detail: unknown, loading: unknown, curve: unknown): Record<string, unknown> {
  return { schema: FATIGUE_DETAIL_INPUT_SCHEMA, detail, loading, curve };
}
function result(value: unknown): FatigueDetailResult {
  const analysis = analyzeFatigueDetail(value);
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  return analysis.result;
}
function finiteLife(value: unknown): number {
  const life = result(value).analysis.life;
  if (life.kind !== 'finite') throw new Error(`life ${life.kind}`);
  return life.spectrumRepetitions;
}
const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
/** Bolt M20x2.5: 120 kN preload level, total bolt force varying by 15 kN, 1000 periods. */
const BOLT_INPUT = (): Record<string, unknown> =>
  input(m20Bolt(), forceLoading('B1', 'bolt-total-axial-force', [forceHistory([120_000, 135_000], { repeats: 1000 })]), F1_TENSILE_AREA());
/** Lap joint, two fillet welds of throat 5 mm and effective length 100 mm, group shear 0 -> 80 kN. */
const WELD_INPUT = (rangeN = 80_000): Record<string, unknown> =>
  input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, rangeN])]), E_WELD_THROAT());

describe('tensile stress area of ISO metric threads (independent oracle: published table)', () => {
  // [ISO] Fastenal page 2 table, As in mm2 as printed; tolerance = half a unit of the last printed digit.
  const table: readonly (readonly [number, number, number, number])[] = [
    [3, 0.5, 5.03, 0.005], [3.5, 0.6, 6.78, 0.005], [4, 0.7, 8.78, 0.005], [5, 0.8, 14.2, 0.05], [6, 1, 20.1, 0.05],
    [7, 1, 28.9, 0.05], [8, 1.25, 36.6, 0.05], [10, 1.5, 58, 0.5], [12, 1.75, 84.3, 0.05], [14, 2, 115, 0.5], [16, 2, 157, 0.5],
    [18, 2.5, 192, 0.5], [20, 2.5, 245, 0.5], [22, 2.5, 303, 0.5], [24, 3, 353, 0.5], [27, 3, 459, 0.5], [30, 3.5, 561, 0.5],
    [33, 3.5, 694, 0.5], [36, 4, 817, 0.5], [39, 4, 976, 0.5],
    [8, 1, 39.2, 0.05], [10, 1.25, 61.2, 0.05], [12, 1.25, 92.1, 0.05], [14, 1.5, 125, 0.5], [16, 1.5, 167, 0.5],
    [18, 1.5, 216, 0.5], [20, 1.5, 272, 0.5], [22, 1.5, 333, 0.5], [24, 2, 384, 0.5], [27, 2, 496, 0.5], [30, 2, 621, 0.5],
    [33, 2, 761, 0.5], [36, 3, 865, 0.5], [39, 3, 1030, 5],
  ];
  it('matches every coarse and fine thread of the table within its printed rounding', () => {
    for (const [diameter, pitch, printed, tolerance] of table) {
      const checked = validateFatigueDetailInput(input(m20Bolt({ kind: 'iso-metric-thread-tensile-stress-area',
        nominalDiameterMm: diameter, pitchMm: pitch }), forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1000])]),
      F1_TENSILE_AREA()));
      if (!checked.ok) throw new Error(`${checked.code} at ${checked.path}`);
      expect(Math.abs(checked.areaMm2 - printed), `M${diameter}x${pitch}`).toBeLessThanOrEqual(tolerance);
      expect(relative(checked.areaMm2, 0.7854 * (diameter - ISO_STRESS_DIAMETER_PITCH * pitch) ** 2)).toBeLessThan(1e-4);
    }
  });
});

describe('bolt in axial tension: known life (DNV-RP-C203 Table A-2 detail 3, curve F1)', () => {
  // As = pi/4 (20 - 0.938194 * 2.5)^2 = 244.794 mm2; delta sigma = 15000 N / As = 61.276 MPa (< 171.0 MPa at 1e5 cycles,
  // > 36.84 MPa at 1e7 cycles, so on the m = 3 line); N = 10^11.699 / 61.276^3 = 5.0003e11 / 230075 = 2.1734e6 cycles.
  // 1000 periods of one closed cycle each: damage 1000 / N, spectrum life N / 1000 = 2173.4 applications.
  const area = (Math.PI / 4) * (20 - ISO_STRESS_DIAMETER_PITCH * 2.5) ** 2;
  const range = 15_000 / area;
  const cycles = 10 ** 11.699 / range ** 3;

  it('converts the total bolt force on the tensile stress area and gives the hand-calculated life', () => {
    const analysis = result(BOLT_INPUT());
    expect(relative(analysis.areaMm2, area)).toBeLessThan(1e-6);
    expect(Math.abs(analysis.areaMm2 - 244.794)).toBeLessThan(1e-3);
    expect(analysis.stressHistories[0]?.stressMpa).toHaveLength(2);
    expect(relative(analysis.stressHistories[0]?.stressMpa[1] ?? Number.NaN, 135_000 / area)).toBeLessThan(1e-6);
    // Closed-loop counting of one period [120, 135] kN: two half cycles of the same range, one cycle in total.
    const counted = analysis.analysis.histories[0]?.cycles ?? [];
    expect(counted.reduce((sum, cycle) => sum + cycle.count, 0)).toBe(1);
    for (const cycle of counted) expect(relative(cycle.rangeMpa, range)).toBeLessThan(1e-6);
    expect(relative(analysis.analysis.damage, 1000 / cycles)).toBeLessThan(1e-6);
    expect(relative(finiteLife(BOLT_INPUT()), cycles / 1000)).toBeLessThan(1e-6);
    expect(relative(cycles, 2.1734e6)).toBeLessThan(1e-4);
    expect(analysis).toMatchObject({ detailKind: 'bolt', detailStress: 'bolt-axial-normal-tensile-stress-area',
      quantity: 'bolt-total-axial-force', codeCompliance: false, structuralCertification: false });
  });

  it('gives the same life from the stress already on the tensile stress area', () => {
    const stressInput = input(m20Bolt(), { detailId: 'B1', location: 'user joint analysis, test fixture', quantity: 'detail-stress',
      stress: 'bolt-axial-normal-tensile-stress-area', histories: [{ id: 'h', unit: 'MPa', stressMpa: [120_000 / area, 135_000 / area],
        sequence: 'repeated-periodic', repeats: 1000, source: LOAD_SOURCE }] }, F1_TENSILE_AREA());
    expect(relative(finiteLife(stressInput), cycles / 1000)).toBeLessThan(1e-6);
  });

  it('fixture: the continuous knee reproduces the tabulated F1 constants within their printed rounding', () => {
    // Table 2-1: fatigue limit at 1e7 cycles 36.84 MPa, log a2 = 14.832 (the piecewise reader needs exact continuity).
    expect(Math.abs(stressAt(11.699, 3, 1e7) - 36.84)).toBeLessThan(0.005);
    expect(Math.abs(7 + 5 * Math.log10(stressAt(11.699, 3, 1e7)) - 14.832)).toBeLessThan(1e-3);
  });
});

describe('fillet weld throat shear: known life (DNV-RP-C203 Table A-8 detail 7, curve E)', () => {
  // Throat area 2 x 5 mm x 100 mm = 1000 mm2. Group shear 0 -> 80 kN: delta tau = 80 MPa (on the m = 3 line).
  // N = 10^12.010 / 80^3 = 1.023293e12 / 512000 = 1.998619e6 cycles; one cycle per application.
  it('converts the group shear on the throat area and gives the hand-calculated life', () => {
    const analysis = result(WELD_INPUT());
    expect(analysis.areaMm2).toBe(1000);
    expect(analysis.stressHistories[0]?.stressMpa).toEqual([0, 80]);
    expect(relative(finiteLife(WELD_INPUT()), 10 ** 12.010 / 80 ** 3)).toBeLessThan(1e-9);
    expect(relative(finiteLife(WELD_INPUT()), 1.998619e6)).toBeLessThan(1e-6);
    expect(analysis).toMatchObject({ detailKind: 'weld', detailStress: 'weld-fillet-throat-nominal-shear',
      quantity: 'weld-group-concentric-shear-force', location: 'user joint analysis, test fixture' });
  });

  it('uses the m = 5 line below the knee (40 kN: 40 MPa < 46.78 MPa)', () => {
    // Continuous knee: N = 1e7 (S_k / 40)^5 with S_k = (10^12.010 / 1e7)^(1/3) = 10^1.67 = 46.774 MPa -> 2.1863e7 cycles.
    // The tabulated second line 10^15.350 / 40^5 = 2.1863e7 agrees (7 + 5 * 1.67 = 15.350 exactly).
    const knee = stressAt(12.010, 3, 1e7);
    const life = finiteLife(WELD_INPUT(40_000));
    expect(relative(life, 1e7 * (knee / 40) ** 5)).toBeLessThan(1e-9);
    expect(relative(life, 10 ** 15.350 / 40 ** 5)).toBeLessThan(1e-9);
    expect(relative(life, 2.1863e7)).toBeLessThan(1e-4);
    // Table 2-1 prints the fatigue limit 46.78 MPa (from the unrounded constant); 10^1.67 = 46.7735 differs by 0.0065.
    expect(Math.abs(knee - 46.78)).toBeLessThan(0.01);
  });
});

describe('the same force on a wrong area or definition is refused', () => {
  it('refuses a bolt nominal shank area against a tensile-stress-area calibration', () => {
    // pi/4 * 20^2 = 314.16 mm2 would make the stress 22 % lower and the life (314.16 / 244.79)^3 = 2.1 times longer.
    const wrong = input(m20Bolt({ kind: 'nominal-shank-area', nominalDiameterMm: 20 }),
      forceLoading('B1', 'bolt-total-axial-force', [forceHistory([120_000, 135_000], { repeats: 1000 })]), F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(wrong)).toEqual({ ok: false, code: 'fatigue-detail-stress-mismatch', path: 'curve.detailStress' });
    expect(Object.keys(analyzeFatigueDetail(wrong))).toEqual(['ok', 'code', 'path']);
  });
  it('refuses a fillet weld leg area against a throat-area calibration', () => {
    const wrong = input(lapWeld({ kind: 'fillet-leg-area', legMm: 7.07, effectiveLengthMm: 100, lines: 2 }),
      forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 80_000])]), E_WELD_THROAT());
    expect(analyzeFatigueDetail(wrong)).toEqual({ ok: false, code: 'fatigue-detail-stress-mismatch', path: 'curve.detailStress' });
  });
  it('refuses a weld calibration on a bolt and a bolt calibration on a weld', () => {
    const boltOnWeldCurve = input(m20Bolt(), forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1000])]), E_WELD_THROAT());
    expect(analyzeFatigueDetail(boltOnWeldCurve)).toEqual({ ok: false, code: 'fatigue-detail-stress-mismatch', path: 'curve.detailStress' });
    const weldOnBoltCurve = input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1000])]),
      F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(weldOnBoltCurve)).toEqual({ ok: false, code: 'fatigue-detail-stress-mismatch', path: 'curve.detailStress' });
  });
  it('refuses a stress loading stated in another definition than the joint produces', () => {
    const wrong = input(m20Bolt(), { detailId: 'B1', location: 'x', quantity: 'detail-stress', stress: 'bolt-axial-normal-nominal-shank-area',
      histories: [{ id: 'h', unit: 'MPa', stressMpa: [0, 50], sequence: 'repeated-periodic', repeats: 1, source: LOAD_SOURCE }] },
    F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(wrong)).toEqual({ ok: false, code: 'fatigue-detail-stress-mismatch', path: 'loading.stress' });
  });
  it('does not distribute an external joint force to a bolt (preload, load-introduction and stiffness are not inferred)', () => {
    const external = input(m20Bolt(), forceLoading('B1', 'joint-external-axial-force', [forceHistory([0, 15_000])]), F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(external)).toEqual({ ok: false, code: 'fatigue-detail-load-distribution', path: 'loading.quantity' });
  });
  it('refuses a quantity that belongs to the other joint kind or an external force on a weld', () => {
    for (const [detail, id, quantity, curve] of [[lapWeld(), 'W1', 'bolt-total-axial-force', E_WELD_THROAT()],
      [lapWeld(), 'W1', 'joint-external-axial-force', E_WELD_THROAT()],
      [m20Bolt(), 'B1', 'weld-group-concentric-shear-force', F1_TENSILE_AREA()]] as const) {
      expect(analyzeFatigueDetail(input(detail, forceLoading(id, quantity, [forceHistory([0, 1000])]), curve)))
        .toEqual({ ok: false, code: 'fatigue-detail-quantity', path: 'loading.quantity' });
    }
  });
  it('refuses a loading taken for another joint', () => {
    const other = input(m20Bolt(), forceLoading('B2', 'bolt-total-axial-force', [forceHistory([0, 1000])]), F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(other)).toEqual({ ok: false, code: 'fatigue-detail-binding', path: 'loading.detailId' });
  });
  it('refuses compression in a bolt (force or stress)', () => {
    const force = input(m20Bolt(), forceLoading('B1', 'bolt-total-axial-force', [forceHistory([1000, -1])]), F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(force)).toEqual({ ok: false, code: 'fatigue-detail-bolt-compression', path: 'loading.histories[0].forceN[1]' });
    const stress = input(m20Bolt(), { detailId: 'B1', location: 'x', quantity: 'detail-stress', stress: 'bolt-axial-normal-tensile-stress-area',
      histories: [{ id: 'h', unit: 'MPa', stressMpa: [10, 20, -5], sequence: 'once', repeats: 1, source: LOAD_SOURCE }] }, F1_TENSILE_AREA());
    expect(analyzeFatigueDetail(stress)).toEqual({ ok: false, code: 'fatigue-detail-bolt-compression', path: 'loading.histories[0].stressMpa[2]' });
  });
});

describe('unsupported joints, stresses, curves and geometry are refused', () => {
  it.each([
    ['rivet kind', input({ ...m20Bolt(), kind: 'rivet' }, forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1])]), F1_TENSILE_AREA()),
      'fatigue-detail-kind', 'detail.kind'],
    ['hot-spot weld method', input({ ...lapWeld(), method: 'hot-spot/1' }, forceLoading('W1', 'weld-group-concentric-shear-force',
      [forceHistory([0, 1])]), E_WELD_THROAT()), 'fatigue-detail-method', 'detail.method'],
    ['bolt in shear', input({ ...m20Bolt(), method: 'bolt-shear/1' }, forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1])]),
      F1_TENSILE_AREA()), 'fatigue-detail-method', 'detail.method'],
    ['eccentric weld load', input({ ...lapWeld(), loadPath: 'eccentric-out-of-plane' }, forceLoading('W1', 'weld-group-concentric-shear-force',
      [forceHistory([0, 1])]), E_WELD_THROAT()), 'fatigue-detail-load-path', 'detail.loadPath'],
    ['partial penetration geometry', input(lapWeld({ kind: 'partial-penetration-throat', throatMm: 5, effectiveLengthMm: 100, lines: 2 }),
      forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]), E_WELD_THROAT()), 'fatigue-detail-geometry',
    'detail.geometry.kind'],
    ['inch thread geometry', input(m20Bolt({ kind: 'unc-thread', nominalDiameterMm: 20, pitchMm: 2.5 }),
      forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1])]), F1_TENSILE_AREA()), 'fatigue-detail-geometry', 'detail.geometry.kind'],
    ['hot-spot curve stress', input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]),
      { ...E_WELD_THROAT(), detailStress: 'weld-hot-spot' }), 'fatigue-detail-stress', 'curve.detailStress'],
    ['member force quantity', input(lapWeld(), forceLoading('W1', 'member-axial-force', [forceHistory([0, 1])]), E_WELD_THROAT()),
      'fatigue-detail-quantity', 'loading.quantity'],
    ['ksi calibration', input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]),
      E_WELD_THROAT({ unit: 'ksi' })), 'fatigue-unit', 'curve.calibration.unit'],
    ['calibration without stress definition', input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force',
      [forceHistory([0, 1])]), E_WELD_THROAT({ stressDefinition: 'max' })), 'fatigue-curve-convention', 'curve.calibration.stressDefinition'],
  ] as const)('%s', (_name, value, code, path) => {
    expect(analyzeFatigueDetail(value)).toEqual({ ok: false, code, path });
  });

  it('refuses a stress range above the calibrated range instead of extrapolating', () => {
    // 1e5-cycle start of the E calibration: (10^12.010 / 1e5)^(1/3) = 217.1 MPa; 300 kN on 1000 mm2 is 300 MPa.
    expect(analyzeFatigueDetail(WELD_INPUT(300_000))).toEqual({ ok: false, code: 'fatigue-piecewise-domain',
      path: 'loading.histories[0].cycles[0]' });
  });
  it('keeps the mean-stress applicability of the calibration (preloaded bolt on a fully-reversed-only curve)', () => {
    const value = input(m20Bolt(), forceLoading('B1', 'bolt-total-axial-force', [forceHistory([120_000, 135_000])]),
      F1_TENSILE_AREA({ meanStressAssumption: 'fully-reversed-only' }));
    expect(analyzeFatigueDetail(value)).toEqual({ ok: false, code: 'fatigue-mean', path: 'loading.histories[0].cycles[0]' });
  });
});

describe('non-finite and malformed input', () => {
  const weldWith = (history: Record<string, unknown>): Record<string, unknown> =>
    input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [history]), E_WELD_THROAT());
  /** [0, <hole>, 1]: length 3 without an own index 1. */
  function holed(): number[] {
    const points: number[] = [];
    points[0] = 0;
    points[2] = 1;
    return points;
  }
  it.each([
    ['NaN force', weldWith(forceHistory([0, Number.NaN])), 'fatigue-number', 'loading.histories[0].forceN[1]'],
    ['infinite force', weldWith(forceHistory([Number.POSITIVE_INFINITY, 0])), 'fatigue-number', 'loading.histories[0].forceN[0]'],
    ['force above 1e9 N', weldWith(forceHistory([0, 2e9])), 'fatigue-bound', 'loading.histories[0].forceN[1]'],
    // 1.1e7 N on 1000 mm2 is 11000 MPa, above the core's 1e4 MPa stress bound.
    ['converted stress above the core bound', weldWith(forceHistory([0, 1.1e7])), 'fatigue-bound', 'loading.histories[0].forceN[1]'],
    ['kN unit', weldWith(forceHistory([0, 1], { unit: 'kN' })), 'fatigue-unit', 'loading.histories[0].unit'],
    ['hole in forces', weldWith(forceHistory(holed())), 'fatigue-shape', 'loading.histories[0].forceN'],
    ['empty forces', weldWith(forceHistory([])), 'fatigue-history', 'loading.histories[0].forceN'],
    ['extra key in history', weldWith({ ...forceHistory([0, 1]), note: 'x' }), 'fatigue-shape', 'loading.histories[0]'],
    ['once with repeats', weldWith(forceHistory([0, 1], { sequence: 'once', repeats: 2 })), 'fatigue-repeats', 'loading.histories[0].repeats'],
    ['missing source', weldWith(forceHistory([0, 1], { source: null })), 'fatigue-shape', 'loading.histories[0].source'],
    ['infinite throat', input(lapWeld({ kind: 'fillet-throat-area', throatMm: Number.POSITIVE_INFINITY, effectiveLengthMm: 100, lines: 2 }),
      forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]), E_WELD_THROAT()), 'fatigue-number',
    'detail.geometry.throatMm'],
    ['zero throat', input(lapWeld({ kind: 'fillet-throat-area', throatMm: 0, effectiveLengthMm: 100, lines: 2 }),
      forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]), E_WELD_THROAT()), 'fatigue-detail-geometry',
    'detail.geometry.throatMm'],
    ['fractional weld lines', input(lapWeld({ kind: 'fillet-throat-area', throatMm: 5, effectiveLengthMm: 100, lines: 1.5 }),
      forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]), E_WELD_THROAT()), 'fatigue-detail-geometry',
    'detail.geometry.lines'],
    ['NaN pitch', input(m20Bolt({ kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm: 20, pitchMm: Number.NaN }),
      forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1])]), F1_TENSILE_AREA()), 'fatigue-number', 'detail.geometry.pitchMm'],
    ['pitch beyond a metric thread', input(m20Bolt({ kind: 'iso-metric-thread-tensile-stress-area', nominalDiameterMm: 20, pitchMm: 6 }),
      forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1])]), F1_TENSILE_AREA()), 'fatigue-detail-geometry', 'detail.geometry.pitchMm'],
    ['pitch on a shank geometry', input(m20Bolt({ kind: 'nominal-shank-area', nominalDiameterMm: 20, pitchMm: 2.5 }),
      forceLoading('B1', 'bolt-total-axial-force', [forceHistory([0, 1])]), F1_TENSILE_AREA()), 'fatigue-shape', 'detail.geometry'],
    ['blank location', input(lapWeld(), { ...forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]), location: ' ' },
      E_WELD_THROAT()), 'fatigue-detail-location', 'loading.location'],
    ['stress loading without stress', input(lapWeld(), { ...forceLoading('W1', 'detail-stress', [forceHistory([0, 1])]) }, E_WELD_THROAT()),
      'fatigue-shape', 'loading'],
    ['curve without binding', input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]),
      { calibration: E_WELD_THROAT().calibration }), 'fatigue-shape', 'curve'],
    ['wrong schema', { ...WELD_INPUT(), schema: 'pointercad-fatigue-detail/2' }, 'fatigue-detail-schema', 'schema'],
    ['extra top-level key', { ...WELD_INPUT(), extra: 1 }, 'fatigue-shape', '$'],
    ['array input', [], 'fatigue-shape', '$'],
    ['null detail', input(null, forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1])]), E_WELD_THROAT()),
      'fatigue-shape', 'detail'],
  ] as const)('%s', (_name, value, code, path) => {
    expect(analyzeFatigueDetail(value)).toEqual({ ok: false, code, path });
  });

  describe('positive dimensions whose area underflows to 0 mm2 are refused on both entries', () => {
    // 1 x 1e-200 mm x 1e-200 mm = 1e-400 mm2, below the smallest double: the area is 0 although each dimension is in range.
    const tiny = lapWeld({ kind: 'fillet-throat-area', throatMm: 1e-200, effectiveLengthMm: 1e-200, lines: 1 });
    const refused = { ok: false, code: 'fatigue-detail-geometry', path: 'detail.geometry' };
    it('stress already in the throat definition (no F / A on this path)', () => {
      const value = input(tiny, { detailId: 'W1', location: 'x', quantity: 'detail-stress', stress: 'weld-fillet-throat-nominal-shear',
        histories: [{ id: 'h', unit: 'MPa', stressMpa: [0, 80], sequence: 'repeated-periodic', repeats: 1, source: LOAD_SOURCE }] },
      E_WELD_THROAT());
      expect(validateFatigueDetailInput(value)).toEqual(refused);
      expect(analyzeFatigueDetail(value)).toEqual(refused);
    });
    it('group shear force (refused as geometry, not as a converted 0 / 0 number)', () => {
      const value = input(tiny, forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 80_000])]), E_WELD_THROAT());
      expect(validateFatigueDetailInput(value)).toEqual(refused);
      expect(analyzeFatigueDetail(value)).toEqual(refused);
    });
  });

  it('refuses duplicate history ids through the unchanged reader', () => {
    const value = input(lapWeld(), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory([0, 1]), forceHistory([0, 2])]),
      E_WELD_THROAT());
    expect(analyzeFatigueDetail(value)).toEqual({ ok: false, code: 'fatigue-id', path: 'loading.histories[1].id' });
  });
});

describe('input is not changed and later changes do not reach a validated input', () => {
  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) deepFreeze(item);
      Object.freeze(value);
    }
    return value;
  }
  it('analyzes a deeply frozen input and leaves it byte-identical', () => {
    const value = deepFreeze(BOLT_INPUT());
    const before = JSON.stringify(value);
    expect(relative(finiteLife(value), 10 ** 11.699 / (15_000 / ((Math.PI / 4) * (20 - ISO_STRESS_DIAMETER_PITCH * 2.5) ** 2)) ** 3 / 1000))
      .toBeLessThan(1e-6);
    expect(JSON.stringify(value)).toBe(before);
  });
  it('returns fresh values', () => {
    const forces = [0, 80_000];
    const geometry = { kind: 'fillet-throat-area', throatMm: 5, effectiveLengthMm: 100, lines: 2 };
    const value = input(lapWeld(geometry), forceLoading('W1', 'weld-group-concentric-shear-force', [forceHistory(forces)]), E_WELD_THROAT());
    const checked = validateFatigueDetailInput(value);
    if (!checked.ok) throw new Error(checked.code);
    forces[1] = 1;
    geometry.throatMm = 50;
    const loading = checked.input.loading;
    expect(loading.quantity === 'detail-stress' ? null : loading.histories[0]?.forceN).toEqual([0, 80_000]);
    expect(checked.stressInput.histories[0]?.stressMpa).toEqual([0, 80]);
    expect(fatigueDetailAreaMm2(checked.input.detail)).toBe(1000);
  });
});
