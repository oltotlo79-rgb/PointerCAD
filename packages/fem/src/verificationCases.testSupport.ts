import type { BeamAnalysisDocument } from './analysisModel.js';
import type { SolidModalInput } from './solidModalModel.js';
import type { BeamBucklingInput } from './bucklingModel.js';
import type { SolidPlasticInput } from './solidPlasticTranslation.js';
import type { VerificationInput } from './verificationComparison.testSupport.js';

export function linearInput(input: BeamAnalysisDocument): VerificationInput {
  const section = input.sections[0], material = input.materials[0];
  return { geometry: { nodes: input.nodes.map(n => ({ id: n.id, position: n.position })),
    members: input.members.map(m => ({ start: m.startNodeId, end: m.endNodeId, localYHint: m.localYHint })),
    area: section.area, iy: section.iy, iz: section.iz, torsion: section.torsionConstant, shearFactor: section.shearFactor },
  boundary: { constraints: input.constraints.map(c => ({ kind: c.kind, nodeId: c.nodeId })),
    loads: input.loads.map(l => ({ nodeId: l.nodeId, force: l.force, moment: l.moment })) },
  material: { young: material.youngModulus, shear: material.shearModulus, density: material.densityKgM3,
    source: { kind: material.source.kind, reference: material.source.reference, condition: material.source.condition } }, units: input.units,
  source: { id: input.id, revision: input.revision, source: { documentId: input.source.documentId,
    documentRevision: input.source.documentRevision, geometryRevision: input.source.geometryRevision } } };
}
export function modalInput(input: SolidModalInput): VerificationInput {
  return { geometry: { nodes: input.nodes, elements: input.elements.map(e => ({ nodes: e.nodes, materialId: e.materialId })), modeCount: input.modeCount },
    boundary: input.constraints.map(c => ({ node: c.node, fixed: c.fixed })),
    material: input.materials.map(m => ({ id: m.id, youngMPa: m.youngMPa, poisson: m.poisson, densityKgM3: m.densityKgM3 })),
    units: input.units, source: { documentId: input.source.documentId, revision: input.source.revision, meshKey: input.source.meshKey } };
}
export function bucklingInput(input: BeamBucklingInput): VerificationInput {
  const geometry = input.geometry, section = geometry.sections[0], material = geometry.materials[0];
  return { geometry: { nodes: geometry.nodes.map(n => n.position), segments: geometry.modal?.segmentsPerMember ?? null,
    area: section.area, iy: section.iy, iz: section.iz, torsion: section.torsionConstant, shearFactor: section.shearFactor }, boundary: { supports: input.supports.map(s => ({ nodeId: s.nodeId, restrained: s.restrained })),
      loads: input.referenceLoads.map(l => ({ id: l.id, kind: l.kind, nodeId: l.nodeId, force: l.force, moment: l.moment })) },
  material: { young: material.youngModulus, shear: material.shearModulus, density: material.densityKgM3,
    source: { kind: material.source.kind, reference: material.source.reference, condition: material.source.condition } }, units: geometry.units, source: { documentId: geometry.source.documentId,
    documentRevision: geometry.source.documentRevision, geometryRevision: geometry.source.geometryRevision } };
}

export function plasticInput(input: SolidPlasticInput): VerificationInput {
  const p = input.plan, m = p.material;
  return { geometry: { nodes: p.nodes, elements: p.elements },
    boundary: { prescribedMm: p.prescribedMm.map(v => ({ node: v.node, dof: v.dof, valueMm: v.valueMm })),
      forcesN: p.forcesN.map(v => ({ node: v.node, dof: v.dof, forceN: v.forceN })),
      loadFactor: p.loadFactor, stepsPerSegment: p.stepsPerSegment },
    material: { youngMPa: m.youngMPa, poisson: m.poisson, yieldStressMPa: m.yieldStressMPa,
      hardeningModulusMPa: m.hardeningModulusMPa, source: { kind: m.source.kind, reference: m.source.reference } },
    units: p.units, source: { documentId: input.source.documentId, revision: input.source.revision } };
}
