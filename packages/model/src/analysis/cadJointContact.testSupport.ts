import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import type { AssemblyComponent } from '../assembly/types.js';
import type { CadAxialBoltInputs } from './axialBoltInput.js';
import { cadWeldLayerFixture } from './cadWeldLayer.testSupport.js';
import { testPlacement, TEST_EVIDENCE } from './beamInputs.testSupport.js';

/** Actual right-angle fillet group plus an actual M8 shank joining its two declared section reference nodes. */
export function cadJointContactFixture() {
  const f = cadWeldLayerFixture([{ start: 10, length: 5 }, { start: 30, length: 5 }]);
  // Existing flat bars: a-base=(25,3,6), b-base=(25,6,3) mm.
  // Rotate the generated shank's +Z axis by -135 degrees around X, through both endpoints.
  const bolt: AssemblyComponent = { id: 'joint-bolt', name: 'explicit mixed axial connector', fixed: true,
    visible: true, suppressed: false, placement: testPlacement([25, 3, 6], [Math.sin(-3*Math.PI/8), 0, 0, Math.cos(-3*Math.PI/8)]),
    source: createStandardPartSource('hexBolt', 'M8', { length: '20' }) };
  const document = { ...f.document, components: [...f.document.components, bolt] };
  const axialBolts: CadAxialBoltInputs = { schema: 'pointercad-cad-axial-bolts/1', source: f.definition.source,
    analysisId: f.definition.id, analysisRevision: f.definition.revision,
    bolts: [{ id: 'mixed-shank', boltComponentId: bolt.id, expectedPartKey: partKeyOf(bolt.source), expectedMaterialId: null,
      first: { memberId: 'a-beam', nodeId: 'a-base' }, second: { memberId: 'b-beam', nodeId: 'b-base' },
      youngMPa: 1000, effectiveAreaMm2: 10, propertySource: TEST_EVIDENCE, idealization: 'bilateral-uniform-axial-elastic' }] };
  return { ...f, document, definition: { ...f.definition, axialBolts, weldLayers: f.associations }, axialBolts };
}
