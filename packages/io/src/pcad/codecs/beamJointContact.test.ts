import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { prepareCadAxialBolts, prepareCadWeldLayers } from '@pointercad/model';
import { cadJointContactFixture } from '../../../../model/src/analysis/cadJointContact.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';

describe('mixed joint inputs in the actual PCAD assembly codec', () => {
  it('roundtrips both complete connector families and revalidates their current CAD owners', () => {
    const f = cadJointContactFixture();
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: f.definition }] };
    const saved = withBeamAnalysisInputs(f.document, attachment), options = { savedAt: '2026-10-16T00:00:00.000Z' };
    const bytes = writeAssemblyDocument(saved, options), reopened = readAssemblyDocument(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.components).toEqual(f.document.components);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(bytes);
    const item = reopened.document.beamAnalysisInputs?.analyses[0];
    if (item?.kind !== 'standard-members' || item.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing mixed saved definition');
    const definition = item.definition;
    expect(prepareCadAxialBolts(reopened.document, definition, definition.axialBolts, f.context).bolts.map(b => b.id)).toEqual(['mixed-shank']);
    expect(prepareCadWeldLayers(reopened.document, definition, definition.weldLayers, f.context).welds.map(w => w.id))
      .toEqual(['effective-throat', 'effective-throat-1']);
    expect(JSON.stringify(item)).not.toMatch(/"(?:centerM|states|axialForceN|forceOnAN|elasticEnergyJ)"/u);
  });
  it('retains independent analysis/source/endpoint refusals for both saved families', () => {
    const f = cadJointContactFixture();
    for (const definition of [
      { ...f.definition, axialBolts: { ...f.axialBolts, analysisRevision: f.definition.revision+1 } },
      { ...f.definition, weldLayers: { ...f.associations, source: { ...f.associations.source, documentId: 'other' } } },
      { ...f.definition, axialBolts: { ...f.axialBolts, bolts: [{ ...f.axialBolts.bolts[0], first: { memberId: 'a-beam', nodeId: 'b-base' } }] } },
      { ...f.definition, weldLayers: { ...f.associations, welds: f.associations.welds.map(w => ({ ...w, first: { memberId: 'b-beam', nodeId: 'a-base' } })) } },
    ]) expect(() => withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1',
      analyses: [{ kind: 'standard-members', definition }] })).toThrow();
  });
});
