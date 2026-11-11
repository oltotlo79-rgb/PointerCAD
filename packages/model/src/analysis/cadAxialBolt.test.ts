import { describe, expect, it } from 'vitest';
import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import type { AssemblyComponent } from '../assembly/types.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import { readCadAxialBoltInputs, type CadAxialBoltInputs } from './axialBoltInput.js';
import { prepareCadAxialBolts } from './cadAxialBolt.js';

function fixture() {
  const base = beamCadFixture(), a = testComponent('a', '10');
  const b = { ...testComponent('b', '10'), placement: testPlacement([0, 0, 20]) };
  const bolt: AssemblyComponent = { id: 'bolt', name: 'explicit axial connector', fixed: true,
    visible: true, suppressed: false, placement: testPlacement([25, 3, 10]),
    source: createStandardPartSource('hexBolt', 'M8', { length: '20' }) };
  const document = { ...base.document, components: [a, b, bolt] };
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'contact', revision: 1,
    source: base.stamp, units: 'N-mm', members: [testMember(a, ['a'], 'a-'), testMember(b, ['b'], 'b-')],
    materials: base.definition.materials, sections: base.definition.sections,
    supports: [{ nodeId: 'a-base', restrained: [true, true, true, true, true, true] },
      { nodeId: 'b-tip', restrained: [true, true, true, true, true, true] }],
    referenceLoads: [{ id: 'force', kind: 'nodal', nodeId: 'a-tip', force: [0, 0, 1], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'b-base', normal: [0, 0, 1], gapMm: 10 }],
      loadFactors: [1, -1] } };
  const associations: CadAxialBoltInputs = { schema: 'pointercad-cad-axial-bolts/1', source: base.stamp,
    analysisId: definition.id, analysisRevision: definition.revision, bolts: [{ id: 'tie', boltComponentId: 'bolt',
      expectedPartKey: partKeyOf(bolt.source), expectedMaterialId: null,
      first: { memberId: 'a-beam', nodeId: 'a-tip' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
      youngMPa: 1000, effectiveAreaMm2: 10, propertySource: TEST_EVIDENCE, idealization: 'bilateral-uniform-axial-elastic' }] };
  const context = { currentSource: base.stamp, bodies: new Map(), assemblyOptions: {} };
  return { document, definition, associations, context };
}

describe('explicit CAD axial bolt boundary', () => {
  it('derives actual owned endpoints and converts MPa/mm2 exactly once against independent EA/L', () => {
    const f = fixture(), before = structuredClone(f.document);
    const result = prepareCadAxialBolts(f.document, f.definition, f.associations, f.context);
    expect(result.geometry.nodes.find(n => n.id === 'a-tip')?.position).toEqual([25, 3, 10]);
    expect(result.geometry.nodes.find(n => n.id === 'b-base')?.position).toEqual([25, 3, 20]);
    expect(result.bolts).toHaveLength(1);
    expect(result.bolts[0]).toMatchObject({ id: 'tie', nodeIdA: 'a-tip', nodeIdB: 'b-base', youngPa: 1e9 });
    expect(result.bolts[0].areaM2).toBeCloseTo(1e-5, 18);
    // E=1000 N/mm2, A=10 mm2, L=10 mm -> k=1000 N/mm=1e6 N/m.
    expect(result.bolts[0].youngPa * result.bolts[0].areaM2 / .01).toBeCloseTo(1e6, 8);
    expect(f.document).toEqual(before);
  });
  it('roundtrips only explicit associations and refuses unsupported properties or sparse lists', () => {
    const f = fixture();
    expect(readCadAxialBoltInputs(JSON.parse(JSON.stringify(f.associations)))).toEqual(f.associations);
    expect(() => readCadAxialBoltInputs({ ...f.associations, bolts: [{ ...f.associations.bolts[0], preloadN: 1 }] })).toThrow();
    expect(() => readCadAxialBoltInputs({ ...f.associations, bolts: new Array(1) })).toThrow();
    expect(() => readCadAxialBoltInputs({ ...f.associations, bolts: [{ ...f.associations.bolts[0], youngMPa: Infinity }] })).toThrow();
  });
  it('refuses stale source, wrong member endpoint and changed bolt material ownership', () => {
    const f = fixture();
    expect(() => prepareCadAxialBolts(f.document, f.definition, f.associations,
      { ...f.context, currentSource: { ...f.context.currentSource, geometryRevision: 'changed' } })).toThrow();
    const wrong = { ...f.associations, bolts: [{ ...f.associations.bolts[0], first: { memberId: 'a-beam', nodeId: 'b-base' } }] };
    expect(() => prepareCadAxialBolts(f.document, f.definition, wrong, f.context)).toThrow();
    const changed = { ...f.document, components: f.document.components.map(c => c.id === 'bolt' ? { ...c, materialId: 'steel' } : c) };
    expect(() => prepareCadAxialBolts(changed, f.definition, f.associations, f.context)).toThrow();
  });
  it('refuses off-axis placement, suppressed bolt and an effective area larger than the actual shank', () => {
    const f = fixture();
    const moved = { ...f.document, components: f.document.components.map(c => c.id === 'bolt'
      ? { ...c, placement: testPlacement([26, 3, 10]) } : c) };
    expect(() => prepareCadAxialBolts(moved, f.definition, f.associations, f.context)).toThrow();
    const hidden = { ...f.document, components: f.document.components.map(c => c.id === 'bolt' ? { ...c, suppressed: true } : c) };
    expect(() => prepareCadAxialBolts(hidden, f.definition, f.associations, f.context)).toThrow();
    expect(() => prepareCadAxialBolts(f.document, f.definition,
      { ...f.associations, bolts: [{ ...f.associations.bolts[0], effectiveAreaMm2: 100 }] }, f.context)).toThrow();
  });
});
