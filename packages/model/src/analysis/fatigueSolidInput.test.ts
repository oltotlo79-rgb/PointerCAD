import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs } from './beamInputs.js';
import { fatigueSolidInputMatches, fatigueSolidSelection, readFatigueSolidSavedInput } from './fatigueSolidInput.js';

const curve = { id: 'test', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
  referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null,
  source: { kind: 'user-supplied', reference: 'Test-only calibration', condition: 'Not material data' } };
function saved() {
  return { schema: 'pointercad-fatigue-solid-saved/1', id: 'fatigue',
    source: { documentId: 'part', revision: 4, meshKey: 'mesh:4' }, inputSha256: 'a'.repeat(64), elementIndex: 3,
    historyId: 'selected-tet', loadFactors: [0, 1, -0.5, 0.25], sequence: 'repeated-periodic', repeats: 7,
    reference: 'Explicit signed chronological load factors', curve };
}

describe('saved solid proportional fatigue selection', () => {
  it('preserves authored factors/curve and exact selection, while excluding derived results', () => {
    const value = saved(), read = readFatigueSolidSavedInput(value, 'definition');
    expect(read).toEqual(value);
    expect(read.loadFactors).not.toBe(value.loadFactors);
    const selection = fatigueSolidSelection(read);
    expect(selection.source).not.toBe(read.source);
    expect(selection.loadFactors).not.toBe(read.loadFactors);
    expect(selection.loadFactors).toEqual([0, 1, -0.5, 0.25]);
    expect(JSON.stringify(read)).not.toMatch(/"(?:result|stressMPa|damage|cycles|tensorInput)"/u);
    const checked = readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'fatigue-solid-proportional', definition: value }] }, 'part');
    expect(checked.ok).toBe(true);
  });
  it('invalidates another document/revision/mesh/digest or missing element without silently migrating', () => {
    const value = readFatigueSolidSavedInput(saved(), 'definition');
    const current = { source: value.source, inputSha256: value.inputSha256, elementCount: 4 };
    expect(fatigueSolidInputMatches(value, current)).toBe(true);
    for (const source of [{ ...value.source, documentId: 'other' }, { ...value.source, revision: 5 },
      { ...value.source, meshKey: 'remeshed' }]) expect(fatigueSolidInputMatches(value, { ...current, source })).toBe(false);
    expect(fatigueSolidInputMatches(value, { ...current, inputSha256: 'b'.repeat(64) })).toBe(false);
    expect(fatigueSolidInputMatches(value, { ...current, elementCount: 3 })).toBe(false);
    expect(fatigueSolidInputMatches({ ...value, elementIndex: -1 }, current)).toBe(false);
    expect(fatigueSolidInputMatches({ ...value, elementIndex: 0.5 }, current)).toBe(false);
  });
  it('rejects unknown schema/derived data/units/identity/selection and sparse or decorated factors', () => {
    const value = saved();
    for (const changed of [{ ...value, schema: 'pointercad-fatigue-solid-saved/2' }, { ...value, result: {} },
      { ...value, stressMPa: [6, 0, 0, 0, 0, 0] }, { ...value, units: 'Pa' }, { ...value, inputSha256: 'bad' },
      { ...value, source: { ...value.source, revision: -1 } }, { ...value, elementIndex: -1 }, { ...value, elementIndex: 50000 },
      { ...value, sequence: 'once', repeats: 2 }, { ...value, loadFactors: new Array<number>(2) },
      { ...value, loadFactors: Object.assign([0, 1], { extra: 1 }) }, { ...value, loadFactors: [0, Number.POSITIVE_INFINITY] }]) {
      expect(() => readFatigueSolidSavedInput(changed, 'definition')).toThrow();
    }
    expect(readBeamAnalysisInputs({ schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'fatigue-solid-proportional', definition: value }] }, 'other').ok).toBe(false);
  });
});
