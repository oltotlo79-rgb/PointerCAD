import { describe, expect, it } from 'vitest';
import { withBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { prepareCadWeldLayers } from '@pointercad/model';
import { cadWeldLayerFixture } from '../../../../model/src/analysis/cadWeldLayer.testSupport.js';
import { readAssemblyDocument, writeAssemblyDocument } from '../assemblyJson.js';

describe('effective weld layer in the real PCAD assembly codec', () => {
  it('roundtrips a complete intermittent group without filling gaps or losing original interval identities', () => {
    const f = cadWeldLayerFixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, weldLayers: f.associations } }] };
    const saved = withBeamAnalysisInputs(f.document, attachment), options = { savedAt: '2026-10-16T00:00:00.000Z' };
    const bytes = writeAssemblyDocument(saved, options), reopened = readAssemblyDocument(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.components).toEqual(f.document.components);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(bytes);
    const analysis = reopened.document.beamAnalysisInputs?.analyses[0];
    if (analysis?.kind !== 'standard-members' || analysis.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing saved intervals');
    const definition = analysis.definition;
    const welds = prepareCadWeldLayers(reopened.document, definition, definition.weldLayers, f.context).welds;
    expect(welds.map(w => w.id)).toEqual(['effective-throat', 'effective-throat-1']);
    expect(welds.map(w => w.widthM)).toEqual([.005, .005]);
    expect(welds[1].centerM[0]-welds[0].centerM[0]).toBeCloseTo(.020, 12);
    const second = f.associations.welds[1].beadComponentId;
    const stale = { ...reopened.document, components: reopened.document.components.filter(c => c.id !== second) };
    expect(() => prepareCadWeldLayers(stale, definition, definition.weldLayers, f.context)).toThrow();
  });
  it('roundtrips the actual bead and explicit assumptions and rederives independent throat geometry', () => {
    const f = cadWeldLayerFixture(), original = structuredClone(f.document);
    const attachment = { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, weldLayers: f.associations } }] };
    const saved = withBeamAnalysisInputs(f.document, attachment);
    const options = { savedAt: '2026-10-16T00:00:00.000Z' };
    const bytes = writeAssemblyDocument(saved, options), reopened = readAssemblyDocument(bytes);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document.beamAnalysisInputs).toEqual(attachment);
    expect(writeAssemblyDocument(reopened.document, options)).toBe(bytes);
    expect(reopened.document.components).toEqual(f.document.components);
    const analysis = reopened.document.beamAnalysisInputs?.analyses[0];
    if (analysis?.kind !== 'standard-members' || analysis.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Missing saved weld input');
    const prepared = prepareCadWeldLayers(reopened.document, analysis.definition, analysis.definition.weldLayers, f.context);
    const weld = prepared.welds[0];
    expect(weld.centerM[0]).toBeCloseTo(.025, 12);
    expect(weld.centerM[1]).toBeCloseTo(.0068, 12);
    expect(weld.centerM[2]).toBeCloseTo(.0066, 12);
    expect(weld.youngPa*weld.widthM*weld.lengthM/weld.thicknessM).toBeCloseTo(2e7, 6);
    expect(f.document).toEqual(original);
    expect(JSON.stringify(analysis)).not.toMatch(/"(?:centerM|states|forceOnAN|momentOnANm|elasticEnergyJ)"/u);
  });
  it('refuses stale identities, foreign endpoints, unsupported fields and serialized collection wrappers', () => {
    const f = cadWeldLayerFixture();
    for (const weldLayers of [
      { ...f.associations, analysisRevision: f.associations.analysisRevision + 1 },
      { ...f.associations, source: { ...f.associations.source, documentId: 'foreign' } },
      { ...f.associations, welds: [{ ...f.associations.welds[0], first: { memberId: 'a-beam', nodeId: 'b-base' } }] },
      { ...f.associations, welds: [{ ...f.associations.welds[0], yieldMPa: 250 }] },
      { ...f.associations, welds: { value: f.associations.welds, Count: 1 } },
    ]) expect(() => withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, weldLayers } }] })).toThrow();
    expect(() => withBeamAnalysisInputs(f.document, { schema: 'pointercad-beam-inputs/1', analyses: [
      { kind: 'standard-members', definition: { ...f.definition, weldLayers: f.associations, axialBolts: {} } }] })).toThrow('Unsupported or missing field');
    const legacy = { schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition: f.definition }] };
    expect(withBeamAnalysisInputs(f.document, legacy).beamAnalysisInputs).toEqual(legacy);
  });
});
