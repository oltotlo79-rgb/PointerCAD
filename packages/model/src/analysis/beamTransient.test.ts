import { describe, expect, it } from 'vitest';
import { readBeamAnalysisInputs, withBeamAnalysisInputs, type StandardBeamTransientDefinition } from './beamInputs.js';
import { bucklingCadFixture } from './beamBuckling.testSupport.js';
import type { BeamTransientHistory } from './beamTransientHistory.js';

const history: BeamTransientHistory = { timeStepS: 1e-4, stepCount: 100, outputEvery: 2, damping: 'none',
  initialConditions: 'zero-at-rest',
  loadFactor: [{ timeS: 0, factor: 0 }, { timeS: 1e-4 * 20, factor: 1 }, { timeS: 1e-4 * 100, factor: 1 }] };

function transientCadFixture() {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamTransientDefinition = {
    schema: 'pointercad-standard-beam/4', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections,
    transient: { segmentsPerMember: old.buckling.segmentsPerMember, history },
    supports: old.supports, referenceLoads: old.referenceLoads,
  };
  return { ...fixture, definition };
}
const attach = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1',
  analyses: [{ kind: 'standard-members', definition }] });

describe('saved transient beam inputs (schema 4)', () => {
  it('decodes exactly what is saved: explicit supports, reference loads, mesh refinement and history only', () => {
    const fixture = transientCadFixture();
    const checked = readBeamAnalysisInputs(attach(fixture.definition), fixture.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}: ${checked.issue.message}`);
    expect(checked.value).toEqual(attach(fixture.definition));
    const saved = checked.value.analyses[0];
    if (saved?.kind !== 'standard-members') throw new Error('Expected standard member input');
    // The buckling decoder's mode-count placeholder is never stored.
    expect(Object.keys(saved.definition).sort()).toEqual(['id', 'materials', 'members', 'referenceLoads', 'revision',
      'schema', 'sections', 'source', 'supports', 'transient', 'units']);
    expect(JSON.stringify(saved.definition)).not.toMatch(/"(?:buckling|modeCount|results|samples|nodes)"/u);
    const edited = withBeamAnalysisInputs(fixture.document, attach(fixture.definition));
    expect(edited.beamAnalysisInputs).toEqual(attach(fixture.definition));
    expect(fixture.document.beamAnalysisInputs).toBeUndefined();
  });

  it('keeps schema 3 unchanged and never mixes schema 3 and 4 fields', () => {
    const buckling = bucklingCadFixture();
    const transient = transientCadFixture();
    expect(readBeamAnalysisInputs(attach(buckling.definition), buckling.document.id).ok).toBe(true);
    const { definition } = transient;
    for (const invalid of [
      { ...buckling.definition, transient: definition.transient },
      { ...definition, buckling: buckling.definition.buckling },
      { ...definition, schema: 'pointercad-standard-beam/3' },
      { ...definition, results: [] },
      { ...definition, transient: { ...definition.transient, modeCount: 1 } },
      { ...definition, transient: { ...definition.transient, history: { ...history, damping: 'rayleigh' } } },
      { ...definition, transient: { ...definition.transient, history: { ...history, initialConditions: 'given' } } },
      { ...definition, transient: { ...definition.transient, segmentsPerMember: 33 } },
      { ...definition, supports: [] },
      { ...definition, referenceLoads: [{ ...definition.referenceLoads[0], force: [0, 0, 0] }] },
      { ...definition, source: { ...definition.source, documentId: 'another-document' } },
    ]) {
      expect(readBeamAnalysisInputs(attach(invalid), transient.document.id).ok, JSON.stringify(Object.keys(invalid))).toBe(false);
    }
  });

  it('decodes the history strictly with the same codes as the FEM boundary and a saved path', () => {
    const fixture = transientCadFixture();
    const at = (change: Record<string, unknown>) => readBeamAnalysisInputs(attach({ ...fixture.definition,
      transient: { ...fixture.definition.transient, history: { ...history, ...change } } }), fixture.document.id);
    for (const [change, code] of [
      [{ stepCount: 101, outputEvery: 1, loadFactor: [{ timeS: 0, factor: 1 }, { timeS: 1e-4 * 101, factor: 1 }] }, 'transient-output'],
      [{ outputEvery: 101 }, 'transient-output'],
      [{ stepCount: 4001 }, 'transient-steps'], [{ stepCount: true }, 'transient-steps'],
      [{ timeStepS: true }, 'transient-number'], [{ timeStepS: 0 }, 'transient-step'],
      [{ timeStepS: 1e-200, loadFactor: [{ timeS: 0, factor: 1 }, { timeS: 1e-198, factor: 1 }] }, 'transient-step'],
      [{ loadFactor: [{ timeS: 0, factor: 1 }, { timeS: 1e-4 * 99, factor: 1 }] }, 'transient-history'],
      [{ loadFactor: [{ timeS: 0, factor: 1 }, { timeS: 0, factor: 1 }, { timeS: 1e-2, factor: 1 }] }, 'transient-history'],
      [{ loadFactor: [{ timeS: 0, factor: Number.NaN }, { timeS: 1e-2, factor: 1 }] }, 'transient-number'],
      [{ loadFactor: [null, { timeS: 1e-2, factor: 1 }] }, 'transient-shape'],
      // A hole would be skipped by Array.map and then dereferenced; it is refused as a shape error instead.
      [{ loadFactor: Object.assign(new Array(3), { 0: { timeS: 0, factor: 1 }, 2: { timeS: 1e-2, factor: 1 } }) }, 'transient-shape'],
      [{ extra: 1 }, 'transient-shape'],
    ] as const) {
      const checked = at(change);
      expect(checked.ok, JSON.stringify(change)).toBe(false);
      if (checked.ok) continue;
      expect(checked.issue.code, JSON.stringify(change)).toBe(code);
      expect(checked.issue.message.startsWith(`${code}:`)).toBe(true);
      expect(checked.issue.path.startsWith('analyses[0].definition.transient.history')).toBe(true);
    }
  });
});
