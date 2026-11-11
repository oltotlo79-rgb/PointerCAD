import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { cadWeldLayerFixture } from '@pointercad/model/testing/analysis-fixtures';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';

describe('explicit weld span through the actual PCAD assembly codec', () => {
  it('roundtrips old /1 and new /2 with the same envelope and no derived state', () => {
    const f = cadWeldLayerFixture(), options = { savedAt: '2026-10-16T00:00:00.000Z' };
    const v2 = { ...f.associations, schema: 'pointercad-cad-weld-layers/2', welds: f.associations.welds.map(w => ({ ...w,
      first: { kind: 'section-node', ...w.first }, second: { kind: 'member-span', memberId: w.second.memberId } })) };
    for (const weldLayers of [f.associations, v2]) {
      const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: { ...f.definition, weldLayers } }] };
      const bytes = writeAssemblyDocument(withBeamAnalysisInputs(f.document, attachment), options);
      const opened = readAssemblyDocument(bytes);
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.document.beamAnalysisInputs).toEqual(attachment);
      expect(writeAssemblyDocument(opened.document, options)).toBe(bytes);
      expect(JSON.stringify(opened.document.beamAnalysisInputs)).not.toMatch(/"(?:meshStates|centerM|nodalActions|elasticEnergyJ)"/u);
    }
  });
});
