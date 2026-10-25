import { describe, expect, it } from 'vitest';
import { InputIssue } from './analysisValidation.js';
import { readStandardBeamImpactSettings } from './beamImpactInput.js';

// task185: the optional saved fibre outlines of the impact settings (mm). Values are hand-chosen; the reader must
// keep old settings byte-identical in meaning and refuse every malformed outline with a typed issue.
const restrained = [true, true, true, true, true, true] as const;
const supports = [{ nodeId: 'a', restrained }];
const nodeIds = new Set(['a', 'b']);
const sectionIds = new Set(['beam-member-1-section', 'beam-member-2-section']);
const base = {
  segmentsPerMember: 4,
  initialVelocities: [{ nodeId: 'b', velocityMPerS: [0, 0, -1] }],
  planes: [{ id: 'plane-1', nodeId: 'b', normal: [0, 0, -1], gapMm: 0.5 }],
  contactStiffnessNPerM: 1e7,
  history: { timeStepS: 1e-5, stepCount: 10, outputEvery: 5 },
};
const read = (value: unknown) => readStandardBeamImpactSettings(value, '$.impact', 4, nodeIds, supports, sectionIds);
function issue(value: unknown): string {
  try {
    read(value);
  } catch (error) {
    if (error instanceof InputIssue) return error.code;
    throw error;
  }
  throw new Error('expected an input issue');
}

describe('saved impact fibre outlines', () => {
  it('settings without outlines read as before, with no fibreSections key', () => {
    const settings = read(base);
    expect(Object.hasOwn(settings, 'fibreSections')).toBe(false);
    expect(settings.planes).toEqual([{ id: 'plane-1', nodeId: 'b', normal: [0, 0, -1], gapMm: 0.5 }]);
  });

  it('reads rectangle, circle and tube outlines exactly and survives a JSON save/reopen', () => {
    const fibreSections = [
      { sectionId: 'beam-member-1-section', outline: { kind: 'rectangle', widthYMm: 20, depthZMm: 40 } },
      { sectionId: 'beam-member-2-section', outline: { kind: 'tube', outsideDiameterMm: 50, wallThicknessMm: 5 } },
    ];
    const settings = read({ ...base, fibreSections });
    expect(settings.fibreSections).toEqual(fibreSections);
    expect(read(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
    expect(read({ ...base, fibreSections: [{ sectionId: 'beam-member-1-section', outline: { kind: 'circle', diameterMm: 30 } }] })
      .fibreSections).toEqual([{ sectionId: 'beam-member-1-section', outline: { kind: 'circle', diameterMm: 30 } }]);
  });

  it.each([
    ['an unknown section', [{ sectionId: 'other-section', outline: { kind: 'circle', diameterMm: 30 } }], 'impact-fibre-section'],
    ['a duplicate section', [{ sectionId: 'beam-member-1-section', outline: { kind: 'circle', diameterMm: 30 } },
      { sectionId: 'beam-member-1-section', outline: { kind: 'circle', diameterMm: 20 } }], 'impact-fibre-section'],
    ['an empty list', [], 'impact-fibre-section'],
    ['an unsupported profile', [{ sectionId: 'beam-member-1-section', outline: { kind: 'hBeam', depthMm: 200 } }], 'impact-fibre-outline'],
    ['a zero size', [{ sectionId: 'beam-member-1-section', outline: { kind: 'rectangle', widthYMm: 0, depthZMm: 40 } }], 'impact-fibre-outline'],
    ['a wall as thick as the radius', [{ sectionId: 'beam-member-1-section',
      outline: { kind: 'tube', outsideDiameterMm: 50, wallThicknessMm: 25 } }], 'impact-fibre-outline'],
  ] as const)('refuses %s', (_label, fibreSections, code) => {
    expect(issue({ ...base, fibreSections })).toBe(code);
  });

  it('refuses extra or misspelled fields instead of ignoring them', () => {
    expect(() => read({ ...base, fibreSections: [{ sectionId: 'beam-member-1-section',
      outline: { kind: 'circle', diameterMm: 30, wallThicknessMm: 2 } }] })).toThrow(InputIssue);
    expect(() => read({ ...base, fibreSection: [] })).toThrow(InputIssue);
    expect(() => read({ ...base, fibreSections: [{ sectionId: 'beam-member-1-section',
      outline: { kind: 'circle', diameterMm: Number.NaN } }] })).toThrow(InputIssue);
  });
});
