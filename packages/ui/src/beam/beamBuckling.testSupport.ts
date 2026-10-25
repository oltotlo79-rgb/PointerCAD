import { translateBeamBuckling, type BeamBucklingInput, type BeamBucklingResult } from '@pointercad/fem';
import { beamUiFixture } from './beam.testSupport.js';
import type { BeamSession } from './beamSession.js';

export function bucklingUiFixture() {
  const fixture = beamUiFixture();
  const session: BeamSession = { ...fixture.session, analysisType: 'buckling', modeCount: 2, segmentsPerMember: 4,
    members: fixture.session.members.map(member => ({ ...member,
      startRestraints: [true, true, true, true, true, true],
      values: { ...member.values, endFx: '0', endFz: '-1' } })) };
  return { ...fixture, session };
}

/** UI lifecycle fixture only; public client numerical acceptance is tested in FEM. */
export function bucklingResultFixture(input: BeamBucklingInput): BeamBucklingResult {
  const { plan } = translateBeamBuckling(input);
  return {
    kind: 'oofem-beam-buckling-3d', method: 'oofem-axial-geometric-stiffness-flexural-eigh/1',
    scope: 'linear-elastic-axial-prestress-flexural-buckling', analysisId: input.geometry.id,
    analysisRevision: input.geometry.revision, source: input.geometry.source, inputSha256: 'b'.repeat(64),
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs: plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0),
    referenceEquilibriumResidual: 0, maximumStiffnessOrthogonalityError: 0, structuralCertification: false,
    modes: Array.from({ length: plan.modeCount }, (_, index) => ({ number: index + 1, loadFactor: 10 * (index + 1),
      normalizedResidual: 0, nodes: plan.nodes.map(node => ({ solverNode: node.number,
        nodeId: node.number <= plan.originalNodeCount ? node.id : null, positionM: node.positionM,
        translation: [node.restrained[0] ? 0 : 1, 0, 0] as const, rotation: [0, 0, 0] as const })) })),
  };
}
