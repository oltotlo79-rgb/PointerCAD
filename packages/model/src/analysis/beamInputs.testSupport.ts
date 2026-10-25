import { expressionValueFromNumber } from '@pointercad/expression';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../assembly/createAssemblyDocument.js';
import { partKeyOf } from '../assembly/resolveAssembly.js';
import { createStandardPartSource } from '../assembly/standard/buildStandardPart.js';
import { STEEL_PRODUCTS, steelProductOptions } from '../assembly/standard/steelCatalog.js';
import type { AssemblyComponent, AssemblyDocument, Placement } from '../assembly/types.js';
import type { AnalysisSource, PropertySource, Vector3 } from './analysisModel.js';
import type { StandardBeamDefinition, StandardBeamMemberInput } from './beamInputs.js';

export const TEST_EVIDENCE: PropertySource = {
  kind: 'user-supplied',
  reference: 'Independent rectangular test section and elastic constants; not inferred from a grade label',
  condition: 'Linear isotropic test material; centroidal principal axes; no capacity claim',
};

export function testPlacement(
  position: Vector3 = [0, 0, 0],
  rotation: Placement['rotation'] = DEFAULT_COMPONENT_PLACEMENT.rotation,
): Placement {
  return {
    position: [
      expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
      expressionValueFromNumber(position[2]),
    ],
    rotation,
  };
}

export function testComponent(id = 'member', length = '2000'): AssemblyComponent {
  const row = STEEL_PRODUCTS.find(product => product.key === 'SS400:flatBar:FB 50×6');
  if (row === undefined) throw new Error('Actual flat-bar test product is unavailable');
  return {
    id, name: id,
    source: createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length }),
    placement: testPlacement(), fixed: true, visible: true, suppressed: false,
  };
}

export function testMember(
  component: AssemblyComponent,
  path: readonly string[] = [component.id],
  prefix = '',
): StandardBeamMemberInput {
  return {
    id: `${prefix}beam`, occurrencePath: path, expectedPartKey: partKeyOf(component.source),
    startNodeId: `${prefix}base`, endNodeId: `${prefix}tip`, materialId: 'elastic', sectionId: 'rectangle',
    sectionFrame: {
      centroidMm: [25, 3, 0], principalY: [1, 0, 0], confirmed: true,
      shearCenterModel: 'coincident-with-centroid', source: TEST_EVIDENCE,
    },
  };
}

export function beamCadFixture(): {
  document: AssemblyDocument;
  definition: StandardBeamDefinition;
  stamp: AnalysisSource;
} {
  const component = testComponent();
  const document: AssemblyDocument = { ...createAssemblyDocument('CAD beam test'), components: [component] };
  const stamp: AnalysisSource = { documentId: document.id, documentRevision: 7, geometryRevision: 'geometry-12' };
  const definition: StandardBeamDefinition = {
    schema: 'pointercad-standard-beam/1', id: 'beam-test', revision: 1, source: stamp, units: 'N-mm',
    members: [testMember(component)],
    materials: [{ id: 'elastic', youngModulus: 208000, shearModulus: 80000, densityKgM3: 7850, source: TEST_EVIDENCE }],
    sections: [{
      id: 'rectangle', area: 300, iy: 900, iz: 62500, torsionConstant: 3300,
      shearFactor: 5 / 6, source: TEST_EVIDENCE,
    }],
    constraints: [{ id: 'clamp', kind: 'fixed', nodeId: 'base' }],
    loads: [{ id: 'load', kind: 'nodal', nodeId: 'tip', force: [10, 0, 0], moment: [0, 0, 0] }],
  };
  return { document, definition, stamp };
}
