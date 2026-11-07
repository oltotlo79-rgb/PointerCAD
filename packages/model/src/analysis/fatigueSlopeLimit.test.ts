import { describe, expect, it } from 'vitest';
import { InputIssue } from './analysisValidation.js';
import { readFatigueSavedInput } from './fatigueInput.js';
import { FATIGUE_SAVED_PIECEWISE_LIMITS, readFatiguePiecewiseSavedInput } from './fatiguePiecewiseInput.js';

/* The saved slope bound 1..32 mirrors the core (the model cannot import @pointercad/fem; fatigueSession.test.ts in the UI
 * compares both readers). 24.096385542168672 and 30.674846625766875 are 1/A of the printed A = 0.0415 and 0.0326 (NIMS
 * NRIM SR 93-02, S45C) computed by PointerCAD; every other value is synthetic and states no material curve. */
const PRINTED_EXPONENTS = [24.096385542168672, 30.674846625766875] as const;
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'unit test only' };
const history = { id: 'h', unit: 'MPa', stressMpa: [125, -125], sequence: 'repeated-periodic', repeats: 2, source };
function singleSaved(slope: number): Record<string, unknown> {
  return { schema: 'pointercad-fatigue-saved/2', id: 'fatigue', source: { documentId: 'doc' }, axial: [],
    input: { schema: 'pointercad-fatigue/1', curve: { id: 'curve', unit: 'MPa', stressDefinition: 'range',
      meanStressAssumption: 'fully-reversed-only', referenceStressMpa: 100, referenceCycles: 1e6, slope, cutoffStressMpa: null, source },
    histories: [history] } };
}
function piecewiseSaved(segments: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: 'doc' },
    input: { schema: 'pointercad-fatigue-piecewise/1',
      curve: { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'fully-reversed-only', segments,
        endCycles: 1e12, end: 'none', applicability: { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' }, source },
      histories: [history] } };
}
function issue(read: () => unknown): { code: string; path: string } | null {
  try {
    read();
  } catch (error) {
    if (error instanceof InputIssue) return { code: error.code, path: error.path };
    throw error;
  }
  return null;
}

describe('saved slope bound 1..32 (single version 2 and piecewise version 5)', () => {
  it('states the piecewise mirror of the core bound', () => {
    expect(FATIGUE_SAVED_PIECEWISE_LIMITS.slope).toEqual([1, 32]);
  });

  it('keeps 1..20 and reads the printed exponents and 32 back exactly', () => {
    for (const slope of [1, 20, ...PRINTED_EXPONENTS, 32]) {
      const single = singleSaved(slope);
      expect(readFatigueSavedInput(single, 'fatigue'), `single ${slope}`).toEqual(single);
      const piecewise = piecewiseSaved([{ fromStressMpa: 400, fromCycles: 1e5, slope }]);
      expect(readFatiguePiecewiseSavedInput(piecewise, 'definition'), `piecewise ${slope}`).toEqual(piecewise);
    }
    // Two segments continuous at the knee: N = 1 * (1e4 / 5000) ** 32 = 2 ** 32 cycles at 5000 MPa.
    const knee = piecewiseSaved([{ fromStressMpa: 1e4, fromCycles: 1, slope: 32 },
      { fromStressMpa: 5000, fromCycles: 2 ** 32, slope: PRINTED_EXPONENTS[1] }]);
    expect(readFatiguePiecewiseSavedInput(knee, 'definition')).toEqual(knee);
  });

  it('refuses above 32, NaN and infinities at the slope field', () => {
    for (const slope of [32.000001, 33, 0.999, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(issue(() => readFatigueSavedInput(singleSaved(slope), 'fatigue')), `single ${slope}`)
        .toEqual({ code: 'fatigue', path: 'fatigue.input.curve.slope' });
      expect(issue(() => readFatiguePiecewiseSavedInput(piecewiseSaved([{ fromStressMpa: 400, fromCycles: 1e5, slope }]), 'definition')),
        `piecewise ${slope}`).toEqual({ code: 'fatigue', path: 'definition.input.curve.segments[0].slope' });
    }
  });
});
