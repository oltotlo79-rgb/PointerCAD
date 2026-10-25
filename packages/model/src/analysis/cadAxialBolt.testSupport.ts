import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import type { AssemblyComponent } from '../assembly/types.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { CadAxialBoltInputs } from './axialBoltInput.js';

export function cadAxialBoltFixture() {
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

