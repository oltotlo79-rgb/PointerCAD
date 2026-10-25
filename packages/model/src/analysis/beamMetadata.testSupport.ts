import type { BeamAnalysisInputs } from './beamInputs.js';

/** A complete valid manual beam attachment; each invocation owns fresh values. */
export function beamMetadataInputs(ownerId: string, force = 10): BeamAnalysisInputs {
  const evidence = {
    kind: 'user-supplied' as const,
    reference: 'Independent metadata regression fixture',
    condition: 'Linear isotropic material and centroidal principal section; no capacity claim',
  };
  return {
    schema: 'pointercad-beam-inputs/1',
    analyses: [{ kind: 'manual', document: {
      schema: 'pointercad-beam/1', id: 'beam-metadata', revision: 1,
      source: { documentId: ownerId, documentRevision: 1, geometryRevision: 'metadata-test' }, units: 'N-mm',
      nodes: [{ id: 'base', position: [0, 0, 0] }, { id: 'tip', position: [0, 0, 2000] }],
      members: [{ id: 'beam', componentId: 'member', occurrencePath: ['member'], startNodeId: 'base', endNodeId: 'tip',
        materialId: 'elastic', sectionId: 'rectangle', localYHint: [1, 0, 0] }],
      materials: [{ id: 'elastic', youngModulus: 208000, shearModulus: 80000, densityKgM3: 7850, source: evidence }],
      sections: [{ id: 'rectangle', area: 300, iy: 900, iz: 62500, torsionConstant: 3300, shearFactor: 5 / 6, source: evidence }],
      constraints: [{ id: 'clamp', kind: 'fixed', nodeId: 'base' }],
      loads: [{ id: 'load', kind: 'nodal', nodeId: 'tip', force: [force, 0, 0], moment: [0, 0, 0] }],
    } }],
  };
}
