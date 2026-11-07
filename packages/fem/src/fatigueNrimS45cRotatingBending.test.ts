import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { analyzeFatiguePiecewise, FATIGUE_PIECEWISE_INPUT_SCHEMA, piecewiseEndStressMpa } from './fatiguePiecewise.js';

/*
 * Printed S-N constants of S45C from S. Nishijima, "Basic Fatigue Properties of JIS Steels for Machine Structural Use",
 * NRIM Special Report No.93-02 (1993), PDF sha256 ae61af3c1edaf6cfd8349d2fb7e934a9e848cac9e283476dbb1e9f997fdb1f05.
 * Only the three ROTATING-BENDING rows of Table A3(1) p.28 (temper 550, 600 and 650 C; mean of 11 per-heat curves each)
 * are used; each was read twice from the page image (second read on an enlarged clip). The rows are never combined: the
 * printed 550-650 summary row mixes three tempers and is not one material condition, so it is not represented.
 * Printed: slope A, fatigue limit sigma_wb (N/mm2), knee D and equation (4) p.7: y = A{|x-D|-(x-D)}/2 + E with
 * y = log sigma, x = log Nf, D = log Nw, E = log sigma_w (50 % failure-probability curve); test conditions "room
 * temperature in laboratory air" WITHOUT a numeric temperature (so no temperature value is stated here); Fig.18 axis
 * "Stress sigma_a" (amplitude); life range above 5x10^4 cycles. NOT printed: a numeric stress ratio, the run-out count,
 * per-specimen points of S45C. COMPUTED (not printed): k = 1/A, Nw = 10^D (log read as log10), the segment start stress
 * at 5e4 cycles and the lives at round amplitudes (owner Python build6b.py, double precision).
 * The curve made of the printed MEAN constants is PointerCAD's own composition; it is NOT a measured mean curve, NOT a
 * verified material property and NOT a standard or guaranteed value. It is not tied to an existing strength row
 * (s45c-quenched-tempered-reference is a different condition), carries no evidence field and stays user-supplied.
 * Below sigma_wb the curve states end: 'none', so such a cycle is refused instead of being counted as infinite life.
 */
interface PrintedRow { readonly temper: '550' | '600' | '650'; readonly A: number; readonly sigmaWb: number; readonly D: number }
/** Table A3(1) p.28, rotating bending, mean (upper) values exactly as printed. */
const PRINTED: readonly PrintedRow[] = [{ temper: '550', A: 0.0647, sigmaWb: 472.4, D: 5.879 },
  { temper: '600', A: 0.0561, sigmaWb: 434.5, D: 6.026 }, { temper: '650', A: 0.0529, sigmaWb: 394.8, D: 6.145 }];
const TEST_LOWER_LIFE = 5e4;
/** Owner Python build6b.py (rev6), independent of this file and of the solver: segment and lives at round amplitudes. */
const PY = {
  550: { fromStressMpa: 563.1937539555953, slope: 15.45595054095827, endCycles: 756832.8950209736,
    known: [[478, 630806.7422850198], [503, 286879.9619489572], [528, 135552.06151946646], [553, 66309.75110568557]] },
  600: { fromStressMpa: 515.7463505231595, slope: 17.825311942959004, endCycles: 1061695.5571987242,
    known: [[440, 848442.0409665767], [465, 316817.94044009165], [490, 124567.98247381356]] },
  650: { fromStressMpa: 470.8386770553376, slope: 18.90359168241966, endCycles: 1396368.3610559362,
    known: [[400, 1090369.6999382006], [425, 346626.9034329465], [450, 117654.18413597971]] },
} as const;
/** The rev6 candidate texts (owner candidates-v2.json, each at most 512 characters), one set per temper. */
const TEXT = {
  550: { material: 'S45C (11 heats sampled 1975-80), 845C water quench + 550C temper, tensile 861.9 N/mm2 mean (NRIM SR 93-02); not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^5.879 cycles; below sigma_wb=472.4 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: 'Nishijima, NRIM Special Report No.93-02 (1993), Table A3(1) p.28, S45C 550C rotating bending means of 11 per-heat curves (A=0.0647, sigma_wb=472.4 N/mm2, D=5.879) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); PDF sha256 ae61af3c1edaf6cfd8349d2fb7e934a9e848cac9e283476dbb1e9f997fdb1f05',
    condition: 'S45C hot rolled bar 19-22 mm, normalized 845C AC, quenched 845C WQ (30 min), tempered 550C WC (60 min), salt bath; rotating bending, smooth d=8 mm, #600 SiC longitudinal polish, load control, room temperature in laboratory air (no value printed), 50% failure probability, R not printed' },
  600: { material: 'S45C (11 heats sampled 1975-80), 845C water quench + 600C temper, tensile 789.7 N/mm2 mean (NRIM SR 93-02); not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^6.026 cycles; below sigma_wb=434.5 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: 'Nishijima, NRIM Special Report No.93-02 (1993), Table A3(1) p.28, S45C 600C rotating bending means of 11 per-heat curves (A=0.0561, sigma_wb=434.5 N/mm2, D=6.026) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); PDF sha256 ae61af3c1edaf6cfd8349d2fb7e934a9e848cac9e283476dbb1e9f997fdb1f05',
    condition: 'S45C hot rolled bar 19-22 mm, normalized 845C AC, quenched 845C WQ (30 min), tempered 600C WC (60 min), salt bath; rotating bending, smooth d=8 mm, #600 SiC longitudinal polish, load control, room temperature in laboratory air (no value printed), 50% failure probability, R not printed' },
  650: { material: 'S45C (11 heats sampled 1975-80), 845C water quench + 650C temper, tensile 717.8 N/mm2 mean (NRIM SR 93-02); not the s45c-quenched-tempered-reference row',
    scope: 'sloped branch of eq.(4) only, 5e4 (printed lower test life) to Nw=10^6.145 cycles; below sigma_wb=394.8 refused (run-out count not printed in SR 93-02); mean-parameter curve, not a design value',
    reference: 'Nishijima, NRIM Special Report No.93-02 (1993), Table A3(1) p.28, S45C 650C rotating bending means of 11 per-heat curves (A=0.0529, sigma_wb=394.8 N/mm2, D=6.145) in eq.(4) p.7; segment start at 5e4 cycles computed by PointerCAD (not printed); PDF sha256 ae61af3c1edaf6cfd8349d2fb7e934a9e848cac9e283476dbb1e9f997fdb1f05',
    condition: 'S45C hot rolled bar 19-22 mm, normalized 845C AC, quenched 845C WQ (30 min), tempered 650C WC (60 min), salt bath; rotating bending, smooth d=8 mm, #600 SiC longitudinal polish, load control, room temperature in laboratory air (no value printed), 50% failure probability, R not printed' },
} as const;
const DETAIL = 'rotating bending nominal surface stress amplitude of smooth d=8 mm specimens; not axial, torsion, notched or welded; room temperature, no numeric value';
const HISTORY_SOURCE = { kind: 'user-supplied', reference: 'test load history only (not a measured service load)',
  condition: 'constant amplitude, fully reversed' } as const;
const DOMAIN = { ok: false, code: 'fatigue-piecewise-domain', path: 'histories[0].cycles[0]' } as const;

const relative = (actual: number, expected: number): number => Math.abs(actual - expected) / Math.abs(expected);
/** One printed row by temper; the printed 550-650 summary (three tempers mixed) and anything else are refused. */
function row(temper: string): PrintedRow {
  const found = PRINTED.find(item => item.temper === temper);
  if (found === undefined) throw new Error(`${temper} is not a single printed material condition`);
  return found;
}
/** Equation (4) as printed, in log form: log10 sigma at Nf cycles (both branches). */
function eq4LogStress({ A, sigmaWb, D }: PrintedRow, cycles: number): number {
  const x = Math.log10(cycles);
  return A * (Math.abs(x - D) - (x - D)) / 2 + Math.log10(sigmaWb);
}
/** The same relation written independently in power form: sigma = sigma_wb (Nw / N)^A below Nw, sigma_wb beyond. */
function powerStress({ A, sigmaWb, D }: PrintedRow, cycles: number): number {
  return sigmaWb * Math.max(1, 10 ** D / cycles) ** A;
}
/** Equation (4) on its sloped branch solved for the life in log form (not the solver's power form). */
function eq4Life({ A, sigmaWb, D }: PrintedRow, amplitude: number): number {
  return 10 ** (D + (Math.log10(sigmaWb) - Math.log10(amplitude)) / A);
}
function curve(temper: PrintedRow['temper'], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const c = PY[temper], t = TEXT[temper];
  return { id: `s45c-qt${temper}-nrim93-rb`, unit: 'MPa', stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only',
    segments: [{ fromStressMpa: c.fromStressMpa, fromCycles: TEST_LOWER_LIFE, slope: c.slope }], endCycles: c.endCycles, end: 'none',
    applicability: { material: t.material, detail: DETAIL, scope: t.scope },
    source: { kind: 'user-supplied', reference: t.reference, condition: t.condition }, ...overrides };
}
/** One fully reversed period with peak `amplitude` about `mean`: one full cycle per period of RANGE 2 x amplitude. */
function reversed(amplitude: number, mean = 0): Record<string, unknown> {
  return { id: 'h', unit: 'MPa', stressMpa: [mean + amplitude, mean - amplitude], sequence: 'repeated-periodic', repeats: 1,
    source: HISTORY_SOURCE };
}
function analyze(curveValue: Record<string, unknown>, amplitude: number, mean = 0): ReturnType<typeof analyzeFatiguePiecewise> {
  return analyzeFatiguePiecewise({ schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curveValue, histories: [reversed(amplitude, mean)] });
}
function finiteLife(analysis: ReturnType<typeof analyzeFatiguePiecewise>): number {
  if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
  if (analysis.result.life.kind !== 'finite') throw new Error(`life ${analysis.result.life.kind}`);
  return analysis.result.life.spectrumRepetitions;
}
const lifeCycles = (temper: PrintedRow['temper'], amplitude: number): number => finiteLife(analyze(curve(temper), amplitude));
interface SegmentOnly { readonly segments: readonly { fromStressMpa: number; fromCycles: number; slope: number }[]; readonly endCycles: number }
const segmentOf = (temper: PrintedRow['temper']): SegmentOnly =>
  ({ segments: [{ fromStressMpa: PY[temper].fromStressMpa, fromCycles: TEST_LOWER_LIFE, slope: PY[temper].slope }], endCycles: PY[temper].endCycles });
/** Saved version 5 configuration of ONE temper (one document holds one fatigue configuration). */
function savedDefinition(temper: PrintedRow['temper'], amplitude: number, extraDefinition: Record<string, unknown> = {},
  curveOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: 'nrim-doc' },
    input: { schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve: curve(temper, curveOverrides), histories: [reversed(amplitude)] },
    ...extraDefinition };
}
/** The document's analysis attachment holding the given saved definitions. */
function attachment(...definitions: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { schema: 'pointercad-beam-inputs/1', analyses: definitions.map(definition => ({ kind: 'fatigue-piecewise', definition })) };
}

describe('S45C rotating bending, NRIM SR 93-02 printed mean constants combined by PointerCAD (not a measured mean curve, not verified, not a standard value)', () => {
  it('re-derives the Python segment of each temper from its own printed A, sigma_wb and D', () => {
    for (const printed of PRINTED) {
      const c = PY[printed.temper];
      expect(relative(1 / printed.A, c.slope)).toBeLessThan(1e-12);
      expect(relative(10 ** printed.D, c.endCycles)).toBeLessThan(1e-12);
      expect(relative(10 ** eq4LogStress(printed, TEST_LOWER_LIFE), c.fromStressMpa)).toBeLessThan(1e-12);
      // The segment ends at the printed knee (sigma_wb at Nw) of the SAME temper.
      expect(relative(piecewiseEndStressMpa(segmentOf(printed.temper)), printed.sigmaWb)).toBeLessThan(1e-12);
    }
  });

  it('agrees between the log form and the power form of eq.(4) on both branches, and the solver inverts it', () => {
    for (const printed of PRINTED) {
      const knee = 10 ** printed.D;
      for (const cycles of [TEST_LOWER_LIFE, 1e5, 2e5, 5e5, knee, 2 * knee, 1e7]) {
        expect(relative(10 ** eq4LogStress(printed, cycles), powerStress(printed, cycles))).toBeLessThan(1e-12);
      }
      // Beyond the knee the printed relation is flat at sigma_wb ...
      expect(relative(10 ** eq4LogStress(printed, 1e7), printed.sigmaWb)).toBeLessThan(1e-12);
      // ... and on the sloped branch the solver's life at the eq.(4) stress returns the same cycle count.
      for (const cycles of [TEST_LOWER_LIFE * 1.5, 1e5, 2e5, 5e5, knee * 0.9]) {
        expect(relative(lifeCycles(printed.temper, 10 ** eq4LogStress(printed, cycles)), cycles)).toBeLessThan(1e-9);
      }
    }
  });

  it('gives the independently computed eq.(4) life at round amplitudes of each temper (MPa amplitude, full cycles)', () => {
    for (const printed of PRINTED) {
      for (const [amplitude, expected] of PY[printed.temper].known) {
        expect(relative(eq4Life(printed, amplitude), expected)).toBeLessThan(1e-12);
        expect(relative(lifeCycles(printed.temper, amplitude), expected)).toBeLessThan(1e-9);
      }
    }
  });

  it('holds the end points of the calibrated range and refuses just outside it instead of extrapolating', () => {
    for (const printed of PRINTED) {
      const c = PY[printed.temper], endStress = piecewiseEndStressMpa(segmentOf(printed.temper));
      expect(relative(lifeCycles(printed.temper, c.fromStressMpa), TEST_LOWER_LIFE)).toBeLessThan(1e-12);
      expect(relative(lifeCycles(printed.temper, endStress), c.endCycles)).toBeLessThan(1e-9);
      expect(analyze(curve(printed.temper), c.fromStressMpa * (1 + 1e-9))).toEqual(DOMAIN);
      expect(analyze(curve(printed.temper), endStress * (1 - 1e-9))).toEqual(DOMAIN);
    }
  });

  it('refuses amplitudes below the printed fatigue limit with end: none instead of reporting an infinite life', () => {
    for (const printed of PRINTED) {
      expect(curve(printed.temper).end).toBe('none');
      for (const amplitude of [printed.sigmaWb - 1, printed.sigmaWb / 2]) {
        expect(analyze(curve(printed.temper), amplitude)).toEqual(DOMAIN);
      }
      // A cut-off declaration would turn the same cycle into "no damaging cycle"; the run-out count that would justify
      // it is not printed in SR 93-02, so the candidates keep 'none'.
      const cutoff = analyze(curve(printed.temper, { end: 'cutoff-at-end' }), printed.sigmaWb - 1);
      expect(cutoff.ok && cutoff.result.life).toEqual({ kind: 'no-damaging-cycle' });
    }
  });

  it('keeps amplitude and full range apart: the curve declaration decides, never a guessed factor of two', () => {
    const p600 = row('600');
    const counted = analyze(curve('600'), 465);
    if (!counted.ok) throw new Error(counted.code);
    // One fully reversed period at amplitude 465 MPa is counted as two half cycles of range 930 MPa and mean 0 (one full
    // cycle per period; the sign of zero is ignored). The amplitude curve is then evaluated at 930 / 2 = 465 MPa.
    expect(counted.result.histories[0]?.cycles.map(({ count, rangeMpa, meanMpa }) => [count, rangeMpa, Math.abs(meanMpa)]))
      .toEqual([[0.5, 930, 0], [0.5, 930, 0]]);
    expect(relative(finiteLife(counted), eq4Life(p600, 465))).toBeLessThan(1e-9);
    // Declared as a RANGE curve, the counted range 930 MPa exceeds the calibrated start.
    expect(analyze(curve('600', { stressDefinition: 'range' }), 465)).toEqual(DOMAIN);
    // The printed amplitude entered as a range (peak 232.5 MPa) is below sigma_wb = 434.5 MPa.
    expect(analyze(curve('600'), 465 / 2)).toEqual(DOMAIN);
    // The range 930 MPa entered as an amplitude is far above the calibration.
    expect(analyze(curve('600'), 930)).toEqual(DOMAIN);
    // Peak 240 MPa: refused on the amplitude curve; on a range-declared curve it is evaluated at the range 480 MPa.
    expect(analyze(curve('600'), 240)).toEqual(DOMAIN);
    expect(relative(finiteLife(analyze(curve('600', { stressDefinition: 'range' }), 240)), eq4Life(p600, 480))).toBeLessThan(1e-9);
  });

  it('refuses a nonzero mean stress (no stress ratio is printed; the curve is fully-reversed-only)', () => {
    for (const printed of PRINTED) {
      expect(analyze(curve(printed.temper), PY[printed.temper].known[1][0], 50))
        .toEqual({ ok: false, code: 'fatigue-mean', path: 'histories[0].cycles[0]' });
    }
  });

  it('does not mix the three tempers: each curve reproduces only its own row and refuses another row\'s domain', () => {
    expect(() => row('550-650')).toThrow(/not a single printed material condition/);
    for (const printed of PRINTED) {
      const endStress = piecewiseEndStressMpa(segmentOf(printed.temper)), own = TEXT[printed.temper];
      const text = `${own.material} ${own.scope} ${own.reference} ${own.condition}`;
      expect(text).toContain(`A=${printed.A}, sigma_wb=${printed.sigmaWb} N/mm2, D=${printed.D}`);
      expect(text).toContain(`${printed.temper}C temper`);
      for (const other of PRINTED.filter(item => item !== printed)) {
        expect(relative(endStress, other.sigmaWb)).toBeGreaterThan(0.05);
        expect(relative(PY[printed.temper].endCycles, 10 ** other.D)).toBeGreaterThan(0.05);
        expect(text).not.toContain(`A=${other.A}`);
        expect(text).not.toContain(`sigma_wb=${other.sigmaWb}`);
        expect(text).not.toContain(`${other.temper}C`);
      }
    }
    // 400 MPa lies on the 650 C curve but below the 600 C and 550 C fatigue limits; 540 MPa only on the 550 C curve.
    expect(relative(lifeCycles('650', 400), eq4Life(row('650'), 400))).toBeLessThan(1e-9);
    expect([analyze(curve('600'), 400), analyze(curve('550'), 400)]).toEqual([DOMAIN, DOMAIN]);
    expect(relative(lifeCycles('550', 540), eq4Life(row('550'), 540))).toBeLessThan(1e-9);
    expect([analyze(curve('600'), 540), analyze(curve('650'), 540)]).toEqual([DOMAIN, DOMAIN]);
  });

  it('states room temperature without a numeric value and attaches no strength-row link or evidence', () => {
    for (const printed of PRINTED) {
      const own = TEXT[printed.temper];
      for (const value of [own.material, own.scope, own.reference, own.condition, DETAIL]) expect(value.length).toBeLessThanOrEqual(512);
      expect(`${DETAIL} ${own.condition}`).toMatch(/room temperature/u);
      expect(`${own.material} ${DETAIL} ${own.scope} ${own.reference} ${own.condition}`).not.toMatch(/(?<!\d)20 ?C\b|temperatureC/u);
      expect(analyze(curve(printed.temper, { materialConditionId: 's45c-quenched-tempered-reference' }), 465))
        .toEqual({ ok: false, code: 'fatigue-shape', path: 'curve' });
      expect(analyze(curve(printed.temper, { source: { kind: 'published', reference: own.reference, condition: own.condition } }), 465))
        .toEqual({ ok: false, code: 'fatigue-source', path: 'curve.source' });
    }
  });
});

describe('the same three rows through the saved version 5 configuration (JSON text, model reader, solver)', () => {
  it('keeps condition and curve of each temper exactly through a JSON round trip and gives the same life', () => {
    for (const printed of PRINTED) {
      const [amplitude, expected] = PY[printed.temper].known[1];
      const value = attachment(savedDefinition(printed.temper, amplitude));
      const text = JSON.stringify(value);
      const read = readBeamAnalysisInputs(JSON.parse(text), 'nrim-doc');
      if (!read.ok) throw new Error(`${read.issue.code} at ${read.issue.path}`);
      expect(read.value).toEqual(value);
      expect(JSON.stringify(read.value)).toBe(text);
      expect(text).not.toMatch(/"(?:damage|life|result|cycles|curveEvidence|evidence|verified|materialConditionId)"/u);
      const saved = read.value.analyses[0];
      if (saved?.kind !== 'fatigue-piecewise') throw new Error('expected the piecewise configuration');
      expect(saved.definition.input.curve).toEqual(curve(printed.temper));
      expect(saved.definition.input.curve.source.condition).toBe(TEXT[printed.temper].condition);
      const life = finiteLife(analyzeFatiguePiecewise(saved.definition.input));
      expect(relative(life, expected)).toBeLessThan(1e-9);
      expect(relative(life, eq4Life(printed, amplitude))).toBeLessThan(1e-9);
    }
  });

  it('refuses an evidence field, a strength-row link and a second temper in the same document', () => {
    const issue = (value: unknown): 'accepted' | { readonly code: string; readonly path: string } => {
      const read = readBeamAnalysisInputs(value, 'nrim-doc');
      return read.ok ? 'accepted' : { code: read.issue.code, path: read.issue.path };
    };
    expect(issue(attachment(savedDefinition('600', 465)))).toBe('accepted');
    expect(issue(attachment(savedDefinition('600', 465, { curveEvidence: { property: 'sn' } }))))
      .toEqual({ code: 'shape', path: 'analyses[0].definition' });
    expect(issue(attachment(savedDefinition('600', 465, {}, { materialConditionId: 's45c-quenched-tempered-reference' }))))
      .toEqual({ code: 'shape', path: 'analyses[0].definition.input.curve' });
    expect(issue(attachment(savedDefinition('550', 503), savedDefinition('600', 465)))).toEqual({ code: 'duplicate-id', path: 'analyses' });
  });
});
