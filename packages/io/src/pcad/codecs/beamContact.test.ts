import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs, type StandardBeamContactDefinition } from '@pointercad/model/beam-analysis';
import { bucklingCadFixture } from '../../../../model/src/analysis/beamBuckling.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from '../schema.js';

function contactAttachment() {
  const fixture = bucklingCadFixture();
  const old = fixture.definition;
  const definition: StandardBeamContactDefinition = {
    schema: 'pointercad-standard-beam/5', id: old.id, revision: old.revision, source: old.source, units: old.units,
    members: old.members, materials: old.materials, sections: old.sections,
    contact: { segmentsPerMember: 8, contacts: [
      { kind: 'node-plane', id: 'tip-stop', nodeId: 'tip', normal: [0, 0, 1], gapMm: 0.5 },
      { kind: 'node-pair', id: 'base-tip', nodeIdA: 'base', nodeIdB: 'tip', normal: [0, 0, 1], gapMm: 0 },
    ], loadFactors: [0.25, 1, -1] },
    supports: old.supports, referenceLoads: old.referenceLoads,
  };
  return { fixture, attachment: { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] } };
}

describe('contact input codec', () => {
  it('round-trips explicit schema 5 inputs exactly through the real assembly file writer and reader', () => {
    const { fixture, attachment } = contactAttachment();
    const document = withBeamAnalysisInputs(fixture.document, attachment);
    const options = { savedAt: '2026-10-12T00:00:00.000Z' };
    const serialized = writeAssemblyDocument(document, options);
    const reopened = readAssemblyDocument(serialized);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(serialized);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs))
      .not.toMatch(/"(?:gapM|states|nodes|normalReactionN|results|buckling|transient)"/u);
    // The attachment schema and the document schema version are unchanged by the new standard-member schema.
    expect(reopened.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });

  it('refuses invented gaps, result injection and unknown contact kinds through the real file reader', () => {
    const { fixture, attachment } = contactAttachment();
    const serialized = writeAssemblyDocument(withBeamAnalysisInputs(fixture.document, attachment),
      { savedAt: '2026-10-12T00:00:00.000Z' });
    // writeAssemblyDocument pretty-prints with JSON.stringify(envelope, null, 2).
    for (const [from, to] of [
      ['"gapMm": 0.5', '"gapMm": -0.5'],
      ['"gapMm": 0.5', '"gapM": 0.0005'],
      ['"kind": "node-plane"', '"kind": "surface-surface"'],
      ['"loadFactors": [', '"states": [], "loadFactors": ['],
      ['"nodeIdB": "tip"', '"nodeIdB": "base"'],
      ['pointercad-standard-beam/5', 'pointercad-standard-beam/999'],
    ] as const) {
      const changed = serialized.replace(from, to);
      expect(changed, from).not.toBe(serialized);
      expect(readAssemblyDocument(changed).ok, from).toBe(false);
    }
  });
});
