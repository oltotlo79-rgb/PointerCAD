import type { Vector3 } from './analysisModel.js';
import type { BeamBucklingInput, BeamBucklingResult } from './bucklingModel.js';
import { translateBeamBuckling } from './bucklingTranslation.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function errorBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e-8;
}
function vector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && Reflect.ownKeys(value).length === 4
    && [0, 1, 2].every(index => Object.hasOwn(value, index)
      && typeof value[index] === 'number' && Number.isFinite(value[index]));
}

export function decodeBeamBuckling(raw: unknown, input: BeamBucklingInput, inputSha256: string): BeamBucklingResult {
  const { plan } = translateBeamBuckling(input);
  const freeDofs = plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0);
  if (!/^[0-9a-f]{64}$/u.test(inputSha256) || !record(raw) || raw.schema !== 'pointercad-oofem-buckling-result/1'
    || raw.meshNodes !== plan.nodes.length || raw.meshElements !== plan.members.length
    || raw.freeDofs !== freeDofs || raw.normalizationLengthM !== plan.normalizationLengthM
    || !errorBound(raw.referenceEquilibriumResidual) || !errorBound(raw.maximumStiffnessOrthogonalityError)
    || !Array.isArray(raw.modes) || raw.modes.length !== plan.modeCount) {
    throw new Error('Invalid buckling result metadata or reference-state equilibrium');
  }
  let previous = 0;
  const modes = raw.modes.map((mode: unknown, index: number) => {
    if (!record(mode) || mode.number !== index + 1 || !positive(mode.loadFactor)
      || mode.loadFactor < previous || !errorBound(mode.normalizedResidual)
      || !Array.isArray(mode.nodes) || mode.nodes.length !== plan.nodes.length) {
      throw new Error('Invalid buckling load factor, residual or mode ordering');
    }
    previous = mode.loadFactor;
    let amplitude = 0;
    const nodes = mode.nodes.map((node: unknown, nodeIndex: number) => {
      const expected = plan.nodes[nodeIndex];
      if (!record(node) || node.number !== expected.number || !vector(node.translation) || !vector(node.rotation)) {
        throw new Error('Invalid buckling mode node or non-finite shape');
      }
      const components = [...node.translation, ...node.rotation];
      if (expected.restrained.some((fixed, axis) => fixed && components[axis] !== 0)) {
        throw new Error('Buckling mode violates a prescribed support');
      }
      amplitude = Math.max(amplitude, Math.hypot(...node.translation), Math.hypot(...node.rotation));
      return { solverNode: expected.number, nodeId: expected.number <= plan.originalNodeCount ? expected.id : null,
        positionM: expected.positionM, translation: node.translation, rotation: node.rotation };
    });
    if (Math.abs(amplitude - 1) > 1e-10) throw new Error('Invalid buckling shape normalization');
    return { number: index + 1, loadFactor: mode.loadFactor, normalizedResidual: mode.normalizedResidual, nodes };
  });
  return {
    kind: 'oofem-beam-buckling-3d', method: 'oofem-axial-geometric-stiffness-flexural-eigh/1',
    scope: 'linear-elastic-axial-prestress-flexural-buckling', analysisId: input.geometry.id,
    analysisRevision: input.geometry.revision, source: input.geometry.source, inputSha256,
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs, referenceEquilibriumResidual: raw.referenceEquilibriumResidual,
    maximumStiffnessOrthogonalityError: raw.maximumStiffnessOrthogonalityError, modes, structuralCertification: false,
  };
}

export function isBeamBucklingResult(value: unknown): value is BeamBucklingResult {
  if (!record(value) || value.kind !== 'oofem-beam-buckling-3d'
    || value.method !== 'oofem-axial-geometric-stiffness-flexural-eigh/1'
    || value.scope !== 'linear-elastic-axial-prestress-flexural-buckling'
    || value.structuralCertification !== false || typeof value.analysisId !== 'string'
    || !Number.isSafeInteger(value.analysisRevision) || typeof value.analysisRevision !== 'number' || value.analysisRevision < 0
    || !record(value.source) || typeof value.source.documentId !== 'string'
    || typeof value.source.documentRevision !== 'number' || !Number.isSafeInteger(value.source.documentRevision)
    || value.source.documentRevision < 0 || typeof value.source.geometryRevision !== 'string'
    || typeof value.inputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.inputSha256)
    || !positive(value.normalizationLengthM) || !positive(value.meshNodes) || !Number.isSafeInteger(value.meshNodes)
    || value.meshNodes > 128 || !positive(value.meshElements) || !Number.isSafeInteger(value.meshElements)
    || !positive(value.freeDofs) || !Number.isSafeInteger(value.freeDofs)
    || !errorBound(value.referenceEquilibriumResidual) || !errorBound(value.maximumStiffnessOrthogonalityError)
    || !Array.isArray(value.modes) || value.modes.length < 1 || value.modes.length > 24) return false;
  const count = value.meshNodes;
  return value.modes.every((mode: unknown) => record(mode) && positive(mode.number) && Number.isSafeInteger(mode.number)
    && positive(mode.loadFactor) && errorBound(mode.normalizedResidual) && Array.isArray(mode.nodes)
    && mode.nodes.length === count && mode.nodes.every((node: unknown) => record(node)
      && positive(node.solverNode) && Number.isSafeInteger(node.solverNode)
      && (node.nodeId === null || typeof node.nodeId === 'string')
      && vector(node.positionM) && vector(node.translation) && vector(node.rotation)));
}

/** Compare the complete decoded result, ignoring only object property insertion order. */
function sameResultStructure(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length
      || Reflect.ownKeys(value).length !== value.length + 1
      || Reflect.ownKeys(expected).length !== expected.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !Object.hasOwn(expected, index)
        || !sameResultStructure(value[index], expected[index])) return false;
    }
    return true;
  }
  if (record(value) && record(expected)) {
    const keys = Reflect.ownKeys(value);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key)
        && sameResultStructure(value[key], expected[key]));
  }
  return value === expected;
}

export function bucklingResultMatches(value: unknown, input: BeamBucklingInput, hash: string): value is BeamBucklingResult {
  if (!isBeamBucklingResult(value)) return false;
  try {
    const decoded = decodeBeamBuckling({ schema: 'pointercad-oofem-buckling-result/1',
      normalizationLengthM: value.normalizationLengthM, meshNodes: value.meshNodes, meshElements: value.meshElements,
      freeDofs: value.freeDofs, referenceEquilibriumResidual: value.referenceEquilibriumResidual,
      maximumStiffnessOrthogonalityError: value.maximumStiffnessOrthogonalityError,
      modes: value.modes.map(mode => ({ ...mode, nodes: mode.nodes.map(node => ({ number: node.solverNode,
        translation: node.translation, rotation: node.rotation })) })),
    }, input, hash);
    return sameResultStructure(value, decoded);
  } catch { return false; }
}
