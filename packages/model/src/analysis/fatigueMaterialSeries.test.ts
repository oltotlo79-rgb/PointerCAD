import { describe, expect, it } from 'vitest';
import { InputIssue } from './analysisValidation.js';
import { readFatiguePiecewiseSavedInput } from './fatiguePiecewiseInput.js';

/*
 * The measured S45C (845C quench + 200C temper) tension-compression series of Murakami, Takada, Toriyama,
 * 材料 46(10) 1149-1154 (1997), Table II, as a saved version-5 piecewise configuration. The single slope is PointerCAD's own
 * fit of the printed inclusion-origin failures (not printed in the source); the test temperature is not stated there.
 * The solver-side known points and refusals are in @pointercad/fem fatigueMaterialBenchmark.test.ts; this file only shows
 * that the existing saved reader keeps the series exactly and that no evidence/verified field can be attached to it.
 */
const source = { kind: 'user-supplied',
  reference: 'Murakami, Takada, Toriyama, 材料 46(10) 1149-1154 (1997), Table II; single slope fitted by PointerCAD (not printed)',
  condition: 'S45C 845C quench, 200C temper, HV~650, smooth d=7 mm, tension-compression R=-1, ~80 Hz, test temperature not stated' };
const curve = { id: 's45c-qt200-murakami1997-fit', unit: 'MPa', stressDefinition: 'amplitude', meanStressAssumption: 'fully-reversed-only',
  segments: [{ fromStressMpa: 666.4, fromCycles: 5938842.242096683, slope: 10.110201447827285 }], endCycles: 9.7e7, end: 'none',
  applicability: { material: 'S45C, 845C water quench + 200C temper, HV about 650 (Murakami et al. 1997); test temperature not stated',
    detail: 'smooth electropolished d=7 mm, tension-compression, R=-1, about 80 Hz, inclusion-origin failures',
    scope: 'owner-fit domain only: amplitude 505.5-666.4 MPa, i.e. owner-regression life 5.938842e6 cycles at 666.4 MPa (fromCycles; not printed) to endCycles 9.7e7; the printed fitted lives 3.83e6 (No.12) to 9.70e7 (No.9) are observations, not this domain; pit-origin step above and run-out region below are refused' },
  source };
function saved(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: 'doc' },
    input: { schema: 'pointercad-fatigue-piecewise/1', curve,
      histories: [{ id: 'h', unit: 'MPa', stressMpa: [588, -588], sequence: 'repeated-periodic', repeats: 1, source }] }, ...extra };
}

describe('measured S45C series as a saved piecewise fatigue input', () => {
  it('reads the series exactly (amplitude, cycles, MPa, its own source and range)', () => {
    const value = saved();
    expect(readFatiguePiecewiseSavedInput(value, 'definition')).toEqual(value);
  });

  it('has no place for property evidence, so it cannot be shown as a verified or guaranteed series', () => {
    let refused: InputIssue | undefined;
    try {
      readFatiguePiecewiseSavedInput(saved({ curveEvidence: { property: 'sn' } }), 'definition');
    } catch (error) {
      if (!(error instanceof InputIssue)) throw error;
      refused = error;
    }
    expect({ code: refused?.code, path: refused?.path }).toEqual({ code: 'shape', path: 'definition' });
  });
});
