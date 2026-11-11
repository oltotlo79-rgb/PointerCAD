import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { analyzeFatiguePiecewise, FATIGUE_PIECEWISE_INPUT_SCHEMA, piecewiseEndStressMpa } from './fatiguePiecewise.js';
import { FATIGUE_SLOPE_LIMITS } from './fatigueModel.js';

/*
 * Printed S-N constants of S45C from S. Nishijima, "Basic Fatigue Properties of JIS Steels for Machine Structural Use",
 * NRIM Special Report No.93-02 (1993), PDF sha256 ae61af3c1edaf6cfd8349d2fb7e934a9e848cac9e283476dbb1e9f997fdb1f05.
 * Only four rows are used, each a single material condition read twice from the page image: Table A3(4) p.31 REVERSED
 * TENSION-COMPRESSION (axial) at temper 600 C, and Table A3(1) p.28 REVERSED TORSION at temper 550, 600 and 650 C (each
 * the mean of 4 per-heat curves). Not represented: the 550-650 torsion summary row (three tempers mixed), the repeated
 * tension row (nonzero mean; no mean-stress correction is made here) and the rotating-bending rows (their own test file).
 * No axial row is printed for 550 or 650 C, so none is made up. Printed: slope A, fatigue limit (sigma_w axial, tau_w
 * torsion, N/mm2), knee D and equation (4) p.7: y = A{|x-D|-(x-D)}/2 + E with y = log stress, x = log Nf, D = log Nw,
 * E = log of the fatigue limit (50 % failure-probability curve); high-cycle tests under load control for lives above
 * 5x10^4 cycles; smooth specimens d = 6 mm (axial) and d = 8 mm (torsion); "room temperature in laboratory air" WITHOUT a
 * numeric temperature. NOT printed: a numeric stress ratio, the run-out count, per-specimen points of S45C.
 * COMPUTED (not printed): k = 1/A, Nw = 10^D (log read as log10), the segment start at 5e4 cycles and the lives at round
 * amplitudes (owner Python check9.py: 50-digit Decimal from eq.(4), independent of this file and of the solver).
 * Tolerances are those of the rotating-bending candidate: 1e-12 between closed forms of eq.(4), 1e-9 for the solver
 * (its power form starts from the double segment start); the Python emulation meets both before they were written here.
 * The torsion curves are SHEAR stress amplitude curves. The solver's scope is one scalar stress history
 * ('uniaxial-scalar-stress-history-linear-damage-estimate') and it cannot tell which stress a number is: a torsion curve
 * applies only to the nominal shear stress history of the same pure reversed torsion, an axial curve only to the nominal
 * axial stress. Nothing here converts shear to axial or equivalent stress. The curves made of printed MEAN constants are
 * PointerCAD's composition, NOT measured mean curves, NOT verified material properties and NOT standard values; they are
 * not tied to a strength row, carry no evidence and stay user-supplied. Slopes 24.1-30.7 need the input bound 1..32.
 */
type Key = 'axial-600' | 'torsion-550' | 'torsion-600' | 'torsion-650';
interface PrintedRow { readonly key: Key; readonly mode: 'axial' | 'torsion'; readonly temper: '550' | '600' | '650';
  readonly symbol: 'sigma_w' | 'tau_w'; readonly A: string; readonly limit: string; readonly D: string }
/** Mean (upper) values exactly as printed, kept as the printed strings. */
const PRINTED: readonly PrintedRow[] = [
  { key: 'axial-600', mode: 'axial', temper: '600', symbol: 'sigma_w', A: '0.0415', limit: '408.5', D: '5.613' },
  { key: 'torsion-550', mode: 'torsion', temper: '550', symbol: 'tau_w', A: '0.0326', limit: '313.0', D: '6.627' },
  { key: 'torsion-600', mode: 'torsion', temper: '600', symbol: 'tau_w', A: '0.0350', limit: '286.5', D: '6.420' },
  { key: 'torsion-650', mode: 'torsion', temper: '650', symbol: 'tau_w', A: '0.0371', limit: '260.3', D: '6.338' }];
const TEST_LOWER_LIFE = 5e4;
/** Owner Python check9.py (rev9): segment and 50-digit eq.(4) lives at round amplitudes (MPa amplitude, full cycles). */
const PY = {
  'axial-600': { fromStressMpa: 445.78382435788507, slope: 24.096385542168672, endCycles: 410204.10298660723,
    known: [[412, 333978.994344044], [425, 157985.63863071185], [440, 68491.35658953631]] },
  'torsion-550': { fromStressMpa: 361.7413170060223, slope: 30.674846625766875, endCycles: 4236429.660495409,
    known: [[320, 2149554.409906778], [335, 527324.1035088361], [350, 137576.01831743759]] },
  'torsion-600': { fromStressMpa: 329.1248514921601, slope: 28.57142857142857, endCycles: 2630267.9918953814,
    known: [[290, 1859226.240012129], [305, 440114.1600702434], [320, 111647.00703025167]] },
  'torsion-650': { fromStressMpa: 299.4209479283344, slope: 26.954177897574123, endCycles: 2177709.7723531593,
    known: [[265, 1344373.8572036643], [280, 304780.7363219679], [295, 74661.79728246582]] },
} as const;
const PDF = 'PDF sha256 ae61af3c1edaf6cfd8349d2fb7e934a9e848cac9e283476dbb1e9f997fdb1f05';
const HEAT = 'S45C hot rolled bar 19-22 mm, normalized 845C AC, quenched 845C WQ (30 min)';
const TAIL = '#600 SiC longitudinal polish, load control, room temperature in laboratory air (no value printed), 50% failure probability, R not printed';
/** One set of texts per row (each at most 512 characters); written out so that a wrong row or temper is visible. */
const TEXT: Readonly<Record<Key, { readonly material: string; readonly scope: string; readonly reference: string; readonly condition: string }>> = {
  'axial-600': { material: 'S45C, 845C water quench + 600C temper, tensile 789.7 N/mm2 as printed in the axial row (NRIM SR 93-02 Table A3(4)); not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^5.613 cycles; below sigma_w=408.5 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: `Nishijima, NRIM Special Report No.93-02 (1993), Table A3(4) p.31, S45C 600C reversed tension-compression means of 4 per-heat curves (A=0.0415, sigma_w=408.5 N/mm2, D=5.613) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); ${PDF}`,
    condition: `${HEAT}, tempered 600C WC (60 min), salt bath; reversed axial loading, smooth d=6 mm, ${TAIL}` },
  'torsion-550': { material: 'S45C, 845C water quench + 550C temper, torsion set of 4 heats (NRIM SR 93-02 Table A3(1)), tensile strength of this set not printed; not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^6.627 cycles; below tau_w=313.0 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: `Nishijima, NRIM Special Report No.93-02 (1993), Table A3(1) p.28, S45C 550C reversed torsion means of 4 per-heat curves (A=0.0326, tau_w=313.0 N/mm2, D=6.627) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); ${PDF}`,
    condition: `${HEAT}, tempered 550C WC (60 min), salt bath; reversed torsion, smooth d=8 mm, ${TAIL}` },
  'torsion-600': { material: 'S45C, 845C water quench + 600C temper, torsion set of 4 heats (NRIM SR 93-02 Table A3(1)), tensile strength of this set not printed; not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^6.420 cycles; below tau_w=286.5 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: `Nishijima, NRIM Special Report No.93-02 (1993), Table A3(1) p.28, S45C 600C reversed torsion means of 4 per-heat curves (A=0.0350, tau_w=286.5 N/mm2, D=6.420) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); ${PDF}`,
    condition: `${HEAT}, tempered 600C WC (60 min), salt bath; reversed torsion, smooth d=8 mm, ${TAIL}` },
  'torsion-650': { material: 'S45C, 845C water quench + 650C temper, torsion set of 4 heats (NRIM SR 93-02 Table A3(1)), tensile strength of this set not printed; not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^6.338 cycles; below tau_w=260.3 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: `Nishijima, NRIM Special Report No.93-02 (1993), Table A3(1) p.28, S45C 650C reversed torsion means of 4 per-heat curves (A=0.0371, tau_w=260.3 N/mm2, D=6.338) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); ${PDF}`,
    condition: `${HEAT}, tempered 650C WC (60 min), salt bath; reversed torsion, smooth d=8 mm, ${TAIL}` },
};
const DETAIL = {
  axial: 'nominal axial (tension-compression) stress amplitude of smooth d=6 mm specimens; the scalar history must be that axial stress; not bending, torsion, an equivalent stress, notched or welded; room temperature, no numeric value',
  torsion: 'nominal surface SHEAR stress amplitude of pure reversed torsion, smooth d=8 mm; the scalar history must be that shear stress, never converted to or from an axial or equivalent (von Mises, Tresca) stress; not bending, combined, notched or welded; room temperature, no numeric value',
} as const;
const HISTORY_SOURCE = { kind: 'user-supplied', reference: 'test load history only (not a measured service load)',
  condition: 'constant amplitude, fully reversed' } as const;
const DOMAIN = { ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' } as const;

const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
const numbers = (row: PrintedRow): { A: number; limit: number; D: number } => ({ A: Number(row.A), limit: Number(row.limit), D: Number(row.D) });
/** One printed single-condition row; mixed tempers, other load modes and tempers without printed numbers are refused. */
function printed(mode: string, temper: string): PrintedRow {
  const found = PRINTED.find(item => item.mode === mode && item.temper === temper);
  if (found === undefined) throw new Error(`${mode} ${temper} is not a printed single material condition here`);
  return found;
}
/** Equation (4) as printed, in log form: log10 of the stress at Nf cycles (both branches). */
function eq4LogStress(row: PrintedRow, cycles: number): number {
  const { A, limit, D } = numbers(row), x = Math.log10(cycles);
  return A * (Math.abs(x - D) - (x - D)) / 2 + Math.log10(limit);
}
/** The same relation written independently in power form: limit (Nw / N)^A below Nw, the limit beyond. */
function powerStress(row: PrintedRow, cycles: number): number {
  const { A, limit, D } = numbers(row);
  return limit * Math.max(1, 10 ** D / cycles) ** A;
}
/** Equation (4) on its sloped branch solved for the life in log form (not the solver's power form). */
function eq4Life(row: PrintedRow, amplitude: number): number {
  const { A, limit, D } = numbers(row);
  return 10 ** (D + (Math.log10(limit) - Math.log10(amplitude)) / A);
}
function curve(key: Key, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const c = PY[key], t = TEXT[key], row = PRINTED.find(item => item.key === key);
  if (row === undefined) throw new Error(key);
  return { id: `s45c-qt${row.temper}-nrim93-${row.mode === 'axial' ? 'ax' : 'tor'}`, unit: 'MPa', stressDefinition: 'amplitude',
    meanStressAssumption: 'fully-reversed-only', segments: [{ fromStressMpa: c.fromStressMpa, fromCycles: TEST_LOWER_LIFE, slope: c.slope }],
    endCycles: c.endCycles, end: 'none', applicability: { material: t.material, detail: DETAIL[row.mode], scope: t.scope },
    source: { kind: 'user-supplied', reference: t.reference, condition: t.condition }, ...overrides };
}
/** One fully reversed period with peak `amplitude` about `mean`: one full cycle per period of RANGE 2 x amplitude. */
function reversed(amplitude: number, mean = 0): Record<string, unknown> {
  return { id: 'h', unit: 'MPa', stressMpa: [mean + amplitude, mean - amplitude], sequence: 'repeated-periodic', repeats: 1, source: HISTORY_SOURCE };
}
function analyze(curveValue: Record<string, unknown>, amplitude: number, mean = 0): ReturnType<typeof analyzeFatiguePiecewise> {
  return analyzeFatiguePiecewise({ schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curveValue, histories: [reversed(amplitude, mean)] });
}
function finiteLife(analysis: ReturnType<typeof analyzeFatiguePiecewise>): number {
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  if (analysis.result.life.kind !== 'finite') throw new Error(`life ${analysis.result.life.kind}`);
  return analysis.result.life.spectrumRepetitions;
}
const lifeCycles = (key: Key, amplitude: number): number => finiteLife(analyze(curve(key), amplitude));
const segmentOf = (key: Key): { segments: { fromStressMpa: number; fromCycles: number; slope: number }[]; endCycles: number } =>
  ({ segments: [{ fromStressMpa: PY[key].fromStressMpa, fromCycles: TEST_LOWER_LIFE, slope: PY[key].slope }], endCycles: PY[key].endCycles });
const allText = (key: Key): string => Object.values(TEXT[key]).join(' ');

describe('S45C reversed axial (600C) and reversed torsion (550/600/650C), NRIM SR 93-02 printed means (not measured mean curves, not verified, not standard values)', () => {
  it('needs the slope input bound 1..32: every printed exponent lies above the old bound 20', () => {
    for (const row of PRINTED) {
      expect(PY[row.key].slope).toBeGreaterThan(20);
      expect(PY[row.key].slope).toBeLessThanOrEqual(FATIGUE_SLOPE_LIMITS.maximum);
    }
  });

  it('re-derives the Python segment of each row from its own printed A, fatigue limit and D', () => {
    for (const row of PRINTED) {
      const c = PY[row.key], { A, limit, D } = numbers(row);
      expect(relative(1 / A, c.slope)).toBeLessThan(1e-12);
      expect(relative(10 ** D, c.endCycles)).toBeLessThan(1e-12);
      expect(relative(10 ** eq4LogStress(row, TEST_LOWER_LIFE), c.fromStressMpa)).toBeLessThan(1e-12);
      // The segment ends at the printed knee of the SAME row: the printed sigma_w or tau_w itself, not a converted value.
      expect(relative(piecewiseEndStressMpa(segmentOf(row.key)), limit)).toBeLessThan(1e-12);
    }
  });

  it('agrees between the log form and the power form of eq.(4) on both branches, and the solver inverts it', () => {
    for (const row of PRINTED) {
      const knee = 10 ** numbers(row).D;
      for (const cycles of [TEST_LOWER_LIFE, 1e5, 2e5, 5e5, knee, 2 * knee, 1e7]) {
        expect(relative(10 ** eq4LogStress(row, cycles), powerStress(row, cycles))).toBeLessThan(1e-12);
      }
      for (const cycles of [TEST_LOWER_LIFE * 1.5, 1e5, 2e5, knee * 0.9]) {
        expect(relative(lifeCycles(row.key, 10 ** eq4LogStress(row, cycles)), cycles)).toBeLessThan(1e-9);
      }
    }
  });

  it('gives the independently computed eq.(4) life at round amplitudes of each row', () => {
    for (const row of PRINTED) {
      for (const [amplitude, expected] of PY[row.key].known) {
        expect(relative(eq4Life(row, amplitude), expected)).toBeLessThan(1e-12);
        expect(relative(lifeCycles(row.key, amplitude), expected)).toBeLessThan(1e-9);
      }
    }
  });

  it('holds the end points of the calibrated range and refuses just outside it; below the limit end: none refuses', () => {
    for (const row of PRINTED) {
      const c = PY[row.key], endStress = piecewiseEndStressMpa(segmentOf(row.key)), { limit } = numbers(row);
      expect(relative(lifeCycles(row.key, c.fromStressMpa), TEST_LOWER_LIFE)).toBeLessThan(1e-12);
      expect(relative(lifeCycles(row.key, endStress), c.endCycles)).toBeLessThan(1e-9);
      expect(analyze(curve(row.key), c.fromStressMpa * (1 + 1e-9))).toEqual(DOMAIN);
      expect(analyze(curve(row.key), endStress * (1 - 1e-9))).toEqual(DOMAIN);
      expect(curve(row.key).end).toBe('none');
      for (const amplitude of [limit - 1, limit / 2]) expect(analyze(curve(row.key), amplitude)).toEqual(DOMAIN);
      // A cut-off would turn the same cycle into "no damaging cycle"; no run-out count is printed, so 'none' is kept.
      const cutoff = analyze(curve(row.key, { end: 'cutoff-at-end' }), limit - 1);
      expect(cutoff.ok && cutoff.result.life).toEqual({ kind: 'no-damaging-cycle' });
    }
  });

  it('keeps amplitude and full range apart on the axial and a torsion curve (never a guessed factor of two)', () => {
    for (const [key, amplitude] of [['axial-600', 425], ['torsion-600', 305]] as const) {
      const row = PRINTED.find(item => item.key === key);
      if (row === undefined) throw new Error(key);
      const counted = analyze(curve(key), amplitude);
      if (!counted.ok) throw new Error(counted.code);
      // One fully reversed period: two half cycles of range 2 x amplitude, mean 0; the amplitude curve is read at range / 2.
      expect(counted.result.histories[0]?.cycles.map(({ count, rangeMpa, meanMpa }) => [count, rangeMpa, Math.abs(meanMpa)]))
        .toEqual([[0.5, 2 * amplitude, 0], [0.5, 2 * amplitude, 0]]);
      expect(relative(finiteLife(counted), eq4Life(row, amplitude))).toBeLessThan(1e-9);
      expect(analyze(curve(key, { stressDefinition: 'range' }), amplitude)).toEqual(DOMAIN);
      expect(analyze(curve(key), amplitude / 2)).toEqual(DOMAIN);
      expect(analyze(curve(key), 2 * amplitude)).toEqual(DOMAIN);
      // A range-declared curve reads peak amplitude / 2 at the range `amplitude`.
      expect(relative(finiteLife(analyze(curve(key, { stressDefinition: 'range' }), amplitude / 2)), eq4Life(row, amplitude))).toBeLessThan(1e-9);
    }
  });

  it('refuses a nonzero mean stress (fully-reversed-only; the repeated tension row is not used)', () => {
    for (const row of PRINTED) {
      expect(analyze(curve(row.key), PY[row.key].known[1][0], 50)).toEqual({ ok: false, code: 'fatigue-mean', path: 'histories[0].cycles[0]' });
    }
    expect(() => printed('repeated-tension', '600')).toThrow(/not a printed single material condition/);
  });

  it('does not mix load modes: axial and torsion domains are disjoint and no shear-to-axial conversion is used', () => {
    const axial = printed('axial', '600'), torsion = printed('torsion', '600');
    // 300 MPa lies only on the 600C torsion curve, 425 MPa only on the axial curve.
    expect(relative(lifeCycles('torsion-600', 300), eq4Life(torsion, 300))).toBeLessThan(1e-9);
    expect([analyze(curve('axial-600'), 300), analyze(curve('torsion-550'), 300), analyze(curve('torsion-650'), 300)]).toEqual([DOMAIN, DOMAIN, DOMAIN]);
    expect(relative(lifeCycles('axial-600', 425), eq4Life(axial, 425))).toBeLessThan(1e-9);
    for (const key of ['torsion-550', 'torsion-600', 'torsion-650'] as const) expect(analyze(curve(key), 425)).toEqual(DOMAIN);
    // The printed tau_w / sigma_w at 600C (286.5 / 408.5 = 0.701) is neither von Mises 1/sqrt(3) nor Tresca 1/2, and the
    // slopes differ (28.6 vs 24.1): no constant factor maps one curve onto the other, so none is applied.
    const ratio = numbers(torsion).limit / numbers(axial).limit;
    expect(relative(ratio, 1 / Math.sqrt(3))).toBeGreaterThan(0.15);
    expect(relative(ratio, 0.5)).toBeGreaterThan(0.15);
    expect(relative(PY['torsion-600'].slope, PY['axial-600'].slope)).toBeGreaterThan(0.15);
    // Each curve states its own stress kind; the solver's scope stays one scalar stress history and cannot tell them apart.
    for (const row of PRINTED) {
      const text = `${DETAIL[row.mode]} ${allText(row.key)}`;
      expect(text).toContain(`${row.symbol}=${row.limit} `);
      expect(text).toContain(row.mode === 'axial' ? 'reversed tension-compression' : 'reversed torsion');
      expect(text).not.toContain(row.mode === 'axial' ? 'tau_w' : 'sigma_w');
      expect(text).toContain(row.mode === 'axial' ? 'd=6 mm' : 'SHEAR stress amplitude');
      const analysis = analyze(curve(row.key), PY[row.key].known[1][0]);
      expect(analysis.ok && [analysis.result.scope, analysis.result.codeCompliance, analysis.result.structuralCertification])
        .toEqual(['uniaxial-scalar-stress-history-linear-damage-estimate', false, false]);
    }
  });

  it('does not mix the tempers: each torsion curve reproduces only its own row', () => {
    expect(() => printed('torsion', '550-650')).toThrow(/not a printed single material condition/);
    for (const row of PRINTED) {
      const endStress = piecewiseEndStressMpa(segmentOf(row.key)), text = allText(row.key);
      expect(text).toContain(`A=${row.A}, ${row.symbol}=${row.limit} N/mm2, D=${row.D}`);
      expect(text).toContain(`${row.temper}C temper`);
      for (const other of PRINTED.filter(item => item !== row)) {
        expect(relative(endStress, numbers(other).limit)).toBeGreaterThan(0.05);
        expect(relative(PY[row.key].endCycles, 10 ** numbers(other).D)).toBeGreaterThan(0.05);
        expect(text).not.toContain(`A=${other.A}`);
        expect(text).not.toContain(`=${other.limit} N/mm2`);
        if (other.temper !== row.temper) expect(text).not.toContain(`${other.temper}C`);
      }
    }
    // In the overlaps both curves give a life, but each only its own eq.(4) life (factor > 5 apart).
    for (const [amplitude, upper, lower] of [[320, 'torsion-550', 'torsion-600'], [290, 'torsion-600', 'torsion-650']] as const) {
      const hi = lifeCycles(upper, amplitude), lo = lifeCycles(lower, amplitude);
      expect(relative(hi, eq4Life(printed('torsion', upper.slice(-3)), amplitude))).toBeLessThan(1e-9);
      expect(relative(lo, eq4Life(printed('torsion', lower.slice(-3)), amplitude))).toBeLessThan(1e-9);
      expect(hi / lo).toBeGreaterThan(5);
    }
    // 340 MPa lies only on the 550C torsion curve, 270 MPa only on the 650C one.
    expect([analyze(curve('torsion-600'), 340), analyze(curve('torsion-650'), 340)]).toEqual([DOMAIN, DOMAIN]);
    expect([analyze(curve('torsion-550'), 270), analyze(curve('torsion-600'), 270)]).toEqual([DOMAIN, DOMAIN]);
    expect(relative(lifeCycles('torsion-550', 340), eq4Life(printed('torsion', '550'), 340))).toBeLessThan(1e-9);
    expect(relative(lifeCycles('torsion-650', 270), eq4Life(printed('torsion', '650'), 270))).toBeLessThan(1e-9);
  });

  it('makes up no temperature: no axial row at 550 or 650C, room temperature without a value, no strength-row link', () => {
    for (const temper of ['550', '650']) expect(() => printed('axial', temper)).toThrow(/not a printed single material condition/);
    for (const row of PRINTED) {
      const own = TEXT[row.key];
      for (const value of [own.material, own.scope, own.reference, own.condition, DETAIL[row.mode]]) expect(value.length).toBeLessThanOrEqual(512);
      expect(`${DETAIL[row.mode]} ${own.condition}`).toMatch(/room temperature/u);
      expect(`${DETAIL[row.mode]} ${allText(row.key)}`).not.toMatch(/(?<!\d)20 ?C\b|temperatureC/u);
      expect(analyze(curve(row.key, { materialConditionId: 's45c-quenched-tempered-reference' }), PY[row.key].known[1][0]))
        .toEqual({ ok: false, code: 'fatigue-shape', path: 'curve' });
      expect(analyze(curve(row.key, { source: { kind: 'published', reference: own.reference, condition: own.condition } }), PY[row.key].known[1][0]))
        .toEqual({ ok: false, code: 'fatigue-source', path: 'curve.source' });
    }
  });
});

describe('the same four rows through the saved version 5 configuration (JSON text, model reader, solver)', () => {
  it('keeps condition and curve of each row exactly through a JSON round trip and gives the same life', () => {
    for (const row of PRINTED) {
      const [amplitude, expected] = PY[row.key].known[1];
      const definition = { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: 'nrim-doc' },
        input: { schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curve(row.key), histories: [reversed(amplitude)] } };
      const value = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'fatigue-piecewise', definition }] };
      const text = JSON.stringify(value);
      const read = readBeamAnalysisInputs(JSON.parse(text), 'nrim-doc');
      if (!read.ok) throw new Error(`${read.issue.code} at ${read.issue.path}`);
      expect(read.value).toEqual(value);
      expect(JSON.stringify(read.value)).toBe(text);
      expect(text).not.toMatch(/"(?:damage|life|result|cycles|curveEvidence|evidence|verified|materialConditionId)"/u);
      const saved = read.value.analyses[0];
      if (saved?.kind !== 'fatigue-piecewise') throw new Error('expected the piecewise configuration');
      expect(saved.definition.input.curve.applicability.detail).toBe(DETAIL[row.mode]);
      const life = finiteLife(analyzeFatiguePiecewise(saved.definition.input));
      expect(relative(life, expected)).toBeLessThan(1e-9);
      expect(relative(life, eq4Life(row, amplitude))).toBeLessThan(1e-9);
    }
  });
});
