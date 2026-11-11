import { describe, expect, it } from 'vitest';
import { InputIssue } from './analysisValidation.js';
import { readFatiguePiecewiseSavedInput } from './fatiguePiecewiseInput.js';

/* SYNTHETIC calibration (task180's two-slope curve), not a steel standard, detail category or FAT class. */
const source = { kind: 'user-supplied', reference: 'synthetic test calibration (not a standard)', condition: 'unit test only' };
const segments = [{ fromStressMpa: 400, fromCycles: 1e5, slope: 3 }, { fromStressMpa: 200, fromCycles: 8e5, slope: 5 }];
function saved(curve: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 'pointercad-fatigue-saved/5', id: 'fatigue', source: { documentId: 'doc' },
    input: { schema: 'pointercad-fatigue-piecewise/1',
      curve: { id: 'two-slope', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'fully-reversed-only', segments,
        endCycles: 1e8, end: 'cutoff-at-end', applicability: { material: 'synthetic', detail: 'synthetic', scope: 'unit test only' },
        source, ...curve },
      histories: [{ id: 'h', unit: 'MPa', stressMpa: [125, -125], sequence: 'repeated-periodic', repeats: 2, source }] } };
}
function issue(value: unknown): { code: string; path: string } {
  try {
    readFatiguePiecewiseSavedInput(value, 'definition');
  } catch (error) {
    if (error instanceof InputIssue) return { code: error.code, path: error.path };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('saved piecewise S-N fatigue input (version 5)', () => {
  it('reads the calibrated input exactly and returns fresh values', () => {
    const value = saved();
    const read = readFatiguePiecewiseSavedInput(value, 'definition');
    expect(read).toEqual(value);
    expect(read.input.curve.segments).not.toBe(segments);
  });

  it('points each calibration error at its row and field', () => {
    const cases: readonly [Record<string, unknown>, string, string][] = [
      [saved({ segments: [segments[1], segments[0]] }), 'fatigue', 'definition.input.curve.segments[1]'],
      [saved({ segments: [segments[0], { fromStressMpa: 210, fromCycles: 8e5, slope: 5 }] }), 'fatigue', 'definition.input.curve.segments[1]'],
      [saved({ segments: [{ fromStressMpa: 400, fromCycles: 1e5, slope: 0 }] }), 'fatigue', 'definition.input.curve.segments[0].slope'],
      [saved({ unit: 'kN/mm2' }), 'fatigue', 'definition.input.curve.unit'],
      [saved({ stressDefinition: 'peak' }), 'fatigue', 'definition.input.curve.stressDefinition'],
      [saved({ endCycles: 8e5 }), 'fatigue', 'definition.input.curve.endCycles'],
      [saved({ end: 'endurance' }), 'fatigue', 'definition.input.curve.end'],
      [saved({ applicability: { material: 'synthetic', detail: ' ', scope: 'unit test only' } }), 'fatigue', 'definition.input.curve.applicability.detail'],
      [saved({ source: { ...source, reference: '' } }), 'fatigue', 'definition.input.curve.source.reference'],
    ];
    for (const [value, code, path] of cases) expect(issue(value)).toEqual({ code, path });
  });

  it('refuses another saved version instead of coercing it', () => {
    expect(issue({ ...saved(), schema: 'pointercad-fatigue-saved/4' })).toEqual({ code: 'unsupported-model', path: 'definition' });
  });
});
