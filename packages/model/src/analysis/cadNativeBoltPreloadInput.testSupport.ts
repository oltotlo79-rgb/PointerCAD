import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { beamCadFixture, testComponent, testMember, testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';
import type { AssemblyComponent } from '../assembly/types.js';
import type { StandardBeamContactDefinition } from './beamInputs.js';
import type { CadNativeBoltPreloadInput, CadNativeBoltPreloadSavedInput } from './cadNativeBoltPreloadInput.js';
function fixture(reverse = false) {
  const base = beamCadFixture(), sign = reverse ? -1 : 1;
  const rotation = reverse ? [1, 0, 0, 0] as const : [0, 0, 0, 1] as const;
  const a = { ...testComponent('a', '50'), placement: testPlacement([0, 0, 0], rotation) };
  const b = { ...testComponent('b', '50'), placement: testPlacement([0, 0, 50 * sign], rotation) };
  const bolt: AssemblyComponent = { id: 'selected-bolt', name: 'M16', fixed: true, visible: true, suppressed: false,
    source: createStandardPartSource('hexBolt', 'M16', { length: '100' }), placement: testPlacement([25, 3 * sign, 0], rotation) };
  const document = { ...base.document, components: [a, b, bolt] };
  const definition: StandardBeamContactDefinition = { schema: 'pointercad-standard-beam/5', id: 'axial', revision: 2,
    source: base.stamp, units: 'N-mm', members: [testMember(a, ['a'], 'a-'), testMember(b, ['b'], 'b-')],
    materials: [{ ...base.definition.materials[0], youngModulus: 200000, shearModulus: 200000 / 2.6 }],
    sections: base.definition.sections,
    supports: ['a-base', 'a-tip', 'b-base', 'b-tip'].map(nodeId => ({ nodeId,
      restrained: [true, true, nodeId === 'a-base', true, true, true] })),
    referenceLoads: [{ id: 'unit', kind: 'nodal', nodeId: 'b-tip', force: [0, 0, sign], moment: [0, 0, 0] }],
    contact: { segmentsPerMember: 1, contacts: [{ id: 'interface', kind: 'node-pair', nodeIdA: 'a-tip', nodeIdB: 'b-base', normal: [0, 0, sign], gapMm: 0 }],
      loadFactors: [0, 1000, 0] },
    axialBolts: { schema: 'pointercad-cad-axial-bolts/1', source: base.stamp, analysisId: 'axial', analysisRevision: 2,
      bolts: [{ id: 'tie', boltComponentId: bolt.id, expectedPartKey: partKeyOf(bolt.source), expectedMaterialId: null,
        first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-tip' },
        youngMPa: 200000, effectiveAreaMm2: 100, propertySource: TEST_EVIDENCE, idealization: 'bilateral-uniform-axial-elastic' }] } };
  const declaration: CadNativeBoltPreloadInput = { schema: 'pointercad-cad-native-bolt-preload/1', source: base.stamp,
    analysisId: 'axial', analysisRevision: 2, boltComponentId: bolt.id, contactId: 'interface', memberIds: ['a-beam', 'b-beam'],
    declaration: { boltId: 'tie', model: 'coaxial-outer-planes-series-bearing', modelSource: TEST_EVIDENCE,
      shankSource: TEST_EVIDENCE, shorteningSource: TEST_EVIDENCE,
      preloadN: { value: 4000, source: TEST_EVIDENCE }, threadCompliance: { value: 2e-9, source: TEST_EVIDENCE },
      headCompliance: { value: 1e-9, source: TEST_EVIDENCE }, bearingCompliance: { value: 2e-9, source: TEST_EVIDENCE },
      memberCompliance: { value: 5 / 3 * 1e-9, source: TEST_EVIDENCE }, externalLoadsN: [1000, 0], loadSource: TEST_EVIDENCE } };
  return { document, definition, declaration, context: { currentSource: base.stamp, bodies: new Map(), assemblyOptions: {} } };
}

/** The approved FB50x6/50+50mm CAD input, not a native result or guessed flexibility. */
export function savedBoltFixture() {
  const f = fixture();
  const saved: CadNativeBoltPreloadSavedInput = { schema: 'pointercad-cad-native-bolt-preload-saved/1',
    id: f.definition.id, revision: f.definition.revision, source: f.definition.source,
    cadDefinition: f.definition, input: f.declaration };
  return { ...f, saved };
}
