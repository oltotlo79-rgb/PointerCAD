import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { cadJointContactFixture } from '../../../../model/src/analysis/cadJointContact.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';

describe('stress-free shortening in the real assembly codec', () => {
  it('roundtrips explicit shortening and provenance without saving derived initial force or results', () => {
    const f = cadJointContactFixture();
    const initialStrain = { schema: 'pointercad-cad-joint-initial-strain/1', shortenings: [{ boltId: 'mixed-shank', shorteningMm: .001,
      source: { kind: 'user-supplied', reference: 'stress-free length assumption', condition: 'elastic reference geometry' } }] };
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: { ...f.definition, initialStrain } }] };
    const saved = withBeamAnalysisInputs(f.document, attachment), options = { savedAt: '2026-10-16T00:00:00.000Z' };
    const bytes = writeAssemblyDocument(saved, options), reopened = readAssemblyDocument(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(bytes);
    expect(reopened.document.components).toEqual(f.document.components);
    expect(JSON.stringify(reopened.document.beamAnalysisInputs)).not.toMatch(/"(?:initialForceN|states|axialForceN|elasticEnergyJ)"/u);
    const legacy = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: f.definition }] };
    expect(withBeamAnalysisInputs(f.document, legacy).beamAnalysisInputs).toEqual(legacy);
  });
  it('refuses missing, foreign or duplicate shanks, torque substitution and single-family initial strain', () => {
    const f = cadJointContactFixture();
    const row = { boltId: 'mixed-shank', shorteningMm: .001,
      source: { kind: 'user-supplied', reference: 'prescribed shortening', condition: 'elastic' } };
    const initialStrain = { schema: 'pointercad-cad-joint-initial-strain/1', shortenings: [row] };
    for (const invalid of [
      { ...initialStrain, shortenings: [] }, { ...initialStrain, shortenings: [row, row] },
      { ...initialStrain, shortenings: [{ ...row, boltId: 'foreign' }] },
      { ...initialStrain, shortenings: [{ ...row, shorteningMm: -1 }] },
      { ...initialStrain, shortenings: [{ ...row, torqueNm: 10 }] },
      { ...initialStrain, shortenings: [{ ...row, source: null }] },
    ]) expect(() => withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, initialStrain: invalid } }] })).toThrow();
    const { weldLayers, ...boltOnly } = f.definition;
    expect(weldLayers).toEqual(f.associations);
    expect(() => withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...boltOnly, initialStrain } }] })).toThrow('initial-strain-joint');
  });
});
