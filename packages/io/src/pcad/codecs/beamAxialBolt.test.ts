import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { cadAxialBoltFixture } from '../../../../model/src/analysis/cadAxialBolt.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';

describe('explicit axial bolt inputs in the real PCAD assembly codec', () => {
  it('preserves association, material evidence and signed load factors without result or derived position data', () => {
    const f = cadAxialBoltFixture();
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, axialBolts: f.associations } }] };
    const original = structuredClone(f.document);
    const document = withBeamAnalysisInputs(f.document, attachment);
    const options = { savedAt: '2026-10-16T00:00:00.000Z' };
    const bytes = writeAssemblyDocument(document, options);
    const reopened = readAssemblyDocument(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(bytes);
    expect(f.document).toEqual(original);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs)).not.toMatch(/"(?:states|displacementM|axialForceN|positionM)"/u);
  });
  it('refuses a stale analysis identity, cross-member endpoint and unsupported preload before file admission', () => {
    const f = cadAxialBoltFixture();
    for (const associations of [
      { ...f.associations, analysisRevision: f.associations.analysisRevision + 1 },
      { ...f.associations, source: { ...f.associations.source, documentId: 'another-document' } },
      { ...f.associations, bolts: [{ ...f.associations.bolts[0], first: { memberId: 'a-beam', nodeId: 'b-base' } }] },
      { ...f.associations, bolts: [{ ...f.associations.bolts[0], preloadN: 100 }] },
    ]) {
      expect(() => withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
        { kind: 'standard-members', definition: { ...f.definition, axialBolts: associations } }] })).toThrow();
    }
  });
});
