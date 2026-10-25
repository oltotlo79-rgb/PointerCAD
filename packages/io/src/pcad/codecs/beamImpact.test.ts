import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs, type StandardBeamImpactDefinition } from '@pointercad/model/beam-analysis';
import { bucklingCadFixture } from '../../../../model/src/analysis/beamBuckling.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from '../schema.js';

/** Buckling CAD member moving at -2 m/s towards a fixed plane. The plane normal is deliberately not unit length. */
function impactAttachment() {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamImpactDefinition = {
    schema: 'pointercad-standard-beam/6', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections, supports: old.supports,
    impact: { segmentsPerMember: 8, initialVelocities: [{ nodeId: 'tip', velocityMPerS: [0, 0, -2] }],
      planes: [{ id: 'tip-stop', nodeId: 'tip', normal: [0, 0, 2], gapMm: 0.5 }],
      contactStiffnessNPerM: 1e7, history: { timeStepS: 1e-5, stepCount: 200, outputEvery: 2 } },
  };
  return { fixture, attachment: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
}

describe('impact input codec (schema 6)', () => {
  it('round-trips explicit schema 6 inputs exactly through the real assembly file writer and reader', () => {
    const { fixture, attachment } = impactAttachment();
    const document = withBeamAnalysisInputs(fixture.document, attachment);
    const options = { savedAt: '2026-10-18T00:00:00.000Z' };
    const serialized = writeAssemblyDocument(document, options);
    const reopened = readAssemblyDocument(serialized);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(serialized);
    // The original (non-unit) normal is stored as entered; normalization happens only when solved.
    const saved = reopened.document.beamAnalysisInputs?.analyses[0];
    expect(saved?.kind === 'standard-members' && saved.definition.schema === 'pointercad-standard-beam/6'
      ? saved.definition.impact.planes[0]?.normal : null).toEqual([0, 0, 2]);
    // No solver result, energy or derived state is ever written.
    expect(JSON.stringify(reopened.document.beamAnalysisInputs))
      .not.toMatch(/"(?:samples|contactPeaks|energyJ|results|states|referenceLoads|buckling|modal|gapM|directionUnit)"/u);
    expect(reopened.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });

  it('refuses malformed, injected or unrecognized impact data through the real file reader', () => {
    const { fixture, attachment } = impactAttachment();
    const serialized = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, attachment),
      { savedAt: '2026-10-18T00:00:00.000Z' });
    // writeAssemblyDocument pretty-prints with JSON.stringify(envelope, null, 2).
    for (const [from, to] of [
      ['"gapMm": 0.5', '"gapMm": -0.5'],
      ['"gapMm": 0.5', '"gapM": 0.0005'],
      ['"contactStiffnessNPerM": 10000000', '"contactStiffnessNPerM": 0'],
      ['"stepCount": 200', '"stepCount": 4001'],
      ['"contactStiffnessNPerM": 10000000', '"samples": [], "contactStiffnessNPerM": 10000000'],
      ['"nodeId": "tip",\n', '"nodeId": "nowhere",\n'],
      ['pointercad-standard-beam/6', 'pointercad-standard-beam/999'],
    ] as const) {
      const changed = serialized.replace(from, to);
      expect(changed, from).not.toBe(serialized);
      expect(readAssemblyDocument(changed).ok, from).toBe(false);
    }
  });
});
