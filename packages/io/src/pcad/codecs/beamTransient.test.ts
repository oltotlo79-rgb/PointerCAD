import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs, type StandardBeamTransientDefinition } from '@pointercad/model/beam-analysis';
import { bucklingCadFixture } from '../../../../model/src/analysis/beamBuckling.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from '../schema.js';

function transientAttachment() {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamTransientDefinition = {
    schema: 'pointercad-standard-beam/4', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections,
    transient: { segmentsPerMember: 8, history: { timeStepS: 0.0005, stepCount: 40, outputEvery: 4,
      loadFactor: [{ timeS: 0, factor: 0 }, { timeS: 0.005, factor: 1 }, { timeS: 0.02, factor: 0 }],
      damping: 'none', initialConditions: 'zero-at-rest' } },
    supports: old.supports, referenceLoads: old.referenceLoads,
  };
  return { fixture, attachment: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
}

describe('transient input codec', () => {
  it('round-trips explicit schema 4 inputs exactly with no derived geometry or results', () => {
    const { fixture, attachment } = transientAttachment();
    const document = withBeamAnalysisInputs(fixture.document, attachment);
    const options = { savedAt: '2026-10-11T00:00:00.000Z' };
    const serialized = writeAssemblyDocument(document, options);
    const reopened = readAssemblyDocument(serialized);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(serialized);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs))
      .not.toMatch(/"(?:nodes|samples|results|peakDisplacementM|worldPlacement|buckling)"/u);
    expect(reopened.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });

  it('refuses unsupported damping, initial states, result injection and unknown schemas through the real file reader', () => {
    const { fixture, attachment } = transientAttachment();
    const serialized = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, attachment),
      { savedAt: '2026-10-11T00:00:00.000Z' });
    // writeAssemblyDocument pretty-prints with JSON.stringify(envelope, null, 2).
    for (const [from, to] of [
      ['"damping": "none"', '"damping": "rayleigh"'],
      ['"initialConditions": "zero-at-rest"', '"initialConditions": "given"'],
      ['"transient": {', '"results": [], "transient": {'],
      ['"outputEvery": 4', '"outputEvery": 4, "samples": []'],
      ['pointercad-standard-beam/4', 'pointercad-standard-beam/999'],
    ] as const) {
      const changed = serialized.replace(from, to);
      expect(changed, from).not.toBe(serialized);
      expect(readAssemblyDocument(changed).ok, from).toBe(false);
    }
  });
});
