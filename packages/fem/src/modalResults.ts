import type { BeamAnalysisDocument, BeamModalResult, BeamModeShape, Vector3 } from './analysisModel.js';
import { translateBeamModal, type OofemModalPlan } from './modalTranslation.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function vector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && value.every(numeric);
}
function boundedError(value: unknown, maximum: number): value is number {
  return numeric(value) && value >= 0 && value <= maximum;
}
function positive(value: unknown): value is number {
  return numeric(value) && value > 0;
}
function rigidCount(plan: OofemModalPlan): number {
  if (plan.nodes.some(node => node.fixed)) return 0;
  const parent = plan.nodes.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) index = parent[index];
    return index;
  };
  for (const member of plan.members) parent[root(member.nodes[1] - 1)] = root(member.nodes[0] - 1);
  return 6 * new Set(parent.map((_, index) => root(index))).size;
}

export function decodeBeamModal(raw: unknown, document: BeamAnalysisDocument, inputSha256: string): BeamModalResult {
  const { plan } = translateBeamModal(document);
  const freeDofs = plan.nodes.filter(node => !node.fixed).length * 6;
  const expectedMass = plan.members.reduce((sum, member) => sum
    + plan.materials[member.material - 1].densityKgM3 * plan.sections[member.section - 1].areaM2 * member.frame.lengthM, 0);
  if (!/^[0-9a-f]{64}$/u.test(inputSha256) || !record(raw) || raw.schema !== 'pointercad-oofem-modal-result/1'
    || !Array.isArray(raw.modes) || raw.modes.length !== plan.modeCount
    || raw.rigidBodyModes !== rigidCount(plan) || raw.normalizationLengthM !== plan.normalizationLengthM
    || raw.meshNodes !== plan.nodes.length || raw.meshElements !== plan.members.length || raw.freeDofs !== freeDofs
    || !positive(raw.totalMassKg) || Math.abs(raw.totalMassKg - expectedMass) > expectedMass * 1e-10
    || !boundedError(raw.maximumMassOrthogonalityError, 1e-8)
    || !boundedError(raw.maximumRigidMotionResidual, 1e-10)) {
    throw new Error('Invalid modal metadata, mass, rigid count or numerical diagnostics');
  }
  let previousFrequency = 0;
  const modes: BeamModeShape[] = raw.modes.map((mode: unknown, index: number) => {
    if (!record(mode) || mode.number !== index + 1 || !positive(mode.frequencyHz)
      || mode.frequencyHz < previousFrequency || !positive(mode.eigenvaluePerSecondSquared)
      || Math.abs(mode.frequencyHz - Math.sqrt(mode.eigenvaluePerSecondSquared) / (2 * Math.PI)) > mode.frequencyHz * 1e-12
      || !boundedError(mode.normalizedResidual, 1e-8) || !positive(mode.generalizedMassKgM2)
      || !Array.isArray(mode.nodes) || mode.nodes.length !== plan.nodes.length) {
      throw new Error('Invalid modal frequency, residual or shape size');
    }
    previousFrequency = mode.frequencyHz;
    let maximum = 0;
    const nodes = mode.nodes.map((value: unknown, nodeIndex: number) => {
      const expected = plan.nodes[nodeIndex];
      if (!record(value) || value.number !== expected.number || !vector(value.translation) || !vector(value.rotation)) {
        throw new Error('Invalid modal node association or vector');
      }
      if (expected.fixed && [...value.translation, ...value.rotation].some(component => component !== 0)) {
        throw new Error('Modal shape violates a physical clamp');
      }
      maximum = Math.max(maximum, Math.hypot(...value.translation), Math.hypot(...value.rotation));
      return { solverNode: expected.number,
        nodeId: expected.number <= plan.originalNodeCount ? expected.id : null,
        positionM: expected.positionM, translation: value.translation, rotation: value.rotation };
    });
    if (Math.abs(maximum - 1) > 1e-10) throw new Error('Modal shape normalization differs');
    return { number: index + 1, frequencyHz: mode.frequencyHz,
      eigenvaluePerSecondSquared: mode.eigenvaluePerSecondSquared,
      normalizedResidual: mode.normalizedResidual, generalizedMassKgM2: mode.generalizedMassKgM2, nodes };
  });
  return { kind: 'oofem-beam-modal-3d', method: 'oofem-beam3d-rotary-mass-numpy-eigh/1',
    analysisId: document.id, analysisRevision: document.revision, source: document.source, inputSha256,
    modes, rigidBodyModes: rigidCount(plan), normalization: 'max-nodal-translation-over-length-or-rotation=1',
    normalizationLengthM: plan.normalizationLengthM, totalMassKg: raw.totalMassKg,
    meshNodes: plan.nodes.length, meshElements: plan.members.length, freeDofs,
    edges: plan.members.map(member => ({ memberId: member.id, nodes: member.nodes })),
    maximumMassOrthogonalityError: raw.maximumMassOrthogonalityError,
    maximumRigidMotionResidual: raw.maximumRigidMotionResidual, structuralCertification: false };
}

export function isBeamModalResult(value: unknown): value is BeamModalResult {
  if (!record(value) || value.kind !== 'oofem-beam-modal-3d'
    || value.method !== 'oofem-beam3d-rotary-mass-numpy-eigh/1' || value.structuralCertification !== false
    || value.normalization !== 'max-nodal-translation-over-length-or-rotation=1'
    || typeof value.analysisId !== 'string' || !numeric(value.analysisRevision) || !Number.isSafeInteger(value.analysisRevision)
    || value.analysisRevision < 0 || !record(value.source) || typeof value.source.documentId !== 'string'
    || !numeric(value.source.documentRevision) || !Number.isSafeInteger(value.source.documentRevision)
    || value.source.documentRevision < 0 || typeof value.source.geometryRevision !== 'string'
    || typeof value.inputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.inputSha256)
    || !positive(value.normalizationLengthM) || !positive(value.totalMassKg)
    || !numeric(value.meshNodes) || !Number.isSafeInteger(value.meshNodes) || value.meshNodes < 2 || value.meshNodes > 128
    || !positive(value.meshElements) || !Number.isSafeInteger(value.meshElements)
    || !positive(value.freeDofs) || !Number.isSafeInteger(value.freeDofs)
    || !numeric(value.rigidBodyModes) || !Number.isSafeInteger(value.rigidBodyModes) || value.rigidBodyModes < 0
    || !boundedError(value.maximumMassOrthogonalityError, 1e-8) || !boundedError(value.maximumRigidMotionResidual, 1e-10)
    || !Array.isArray(value.edges) || value.edges.length !== value.meshElements
    || !value.edges.every(edge => record(edge) && typeof edge.memberId === 'string'
      && Array.isArray(edge.nodes) && edge.nodes.length === 2
      && edge.nodes.every(node => positive(node) && Number.isSafeInteger(node)))
    || !Array.isArray(value.modes) || value.modes.length < 1 || value.modes.length > 24) return false;
  const count = value.meshNodes;
  return value.modes.every(mode => record(mode) && positive(mode.number) && Number.isSafeInteger(mode.number)
    && positive(mode.frequencyHz) && positive(mode.eigenvaluePerSecondSquared)
    && boundedError(mode.normalizedResidual, 1e-8) && positive(mode.generalizedMassKgM2)
    && Array.isArray(mode.nodes) && mode.nodes.length === count
    && mode.nodes.every(node => record(node) && positive(node.solverNode) && Number.isSafeInteger(node.solverNode)
      && (node.nodeId === null || typeof node.nodeId === 'string') && vector(node.positionM)
      && vector(node.translation) && vector(node.rotation)));
}

export function modalResultMatches(value: unknown, document: BeamAnalysisDocument, inputSha256: string): value is BeamModalResult {
  if (!isBeamModalResult(value)) return false;
  try {
    const raw = { schema: 'pointercad-oofem-modal-result/1',
      rigidBodyModes: value.rigidBodyModes, normalizationLengthM: value.normalizationLengthM,
      totalMassKg: value.totalMassKg, meshNodes: value.meshNodes, meshElements: value.meshElements,
      freeDofs: value.freeDofs, maximumMassOrthogonalityError: value.maximumMassOrthogonalityError,
      maximumRigidMotionResidual: value.maximumRigidMotionResidual,
      modes: value.modes.map(mode => ({ ...mode, nodes: mode.nodes.map(node => ({
        number: node.solverNode, translation: node.translation, rotation: node.rotation,
      })) })),
    };
    return JSON.stringify(value) === JSON.stringify(decodeBeamModal(raw, document, inputSha256));
  } catch {
    return false;
  }
}
