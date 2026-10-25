import type { Vector3 } from './analysisModel.js';
import type { BeamTransientInput, BeamTransientResult, TransientNodeResponse, TransientSample } from './transientModel.js';
import { transientLoadFactor, transientOutputSteps, translateBeamTransient } from './transientTranslation.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function rayleigh(value: unknown): value is Exclude<BeamTransientInput['history']['damping'], 'none'> {
  return record(value) && Reflect.ownKeys(value).length === 3 && Object.hasOwn(value, 'kind')
    && Object.hasOwn(value, 'massCoefficientPerS') && Object.hasOwn(value, 'stiffnessCoefficientS')
    && value.kind === 'rayleigh' && nonnegative(value.massCoefficientPerS) && nonnegative(value.stiffnessCoefficientS);
}
/** The integrator rejects above 1e-8; the decoder enforces the same stated bound. */
function errorBound(value: unknown): value is number {
  return nonnegative(value) && value <= 1e-8;
}
function vector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && Reflect.ownKeys(value).length === 4
    && [0, 1, 2].every(index => Object.hasOwn(value, index)
      && typeof value[index] === 'number' && Number.isFinite(value[index]));
}
const responseFields = ['displacementM', 'rotationRad', 'velocityMPerS', 'angularVelocityRadPerS',
  'accelerationMPerS2', 'angularAccelerationRadPerS2'] as const;

export function decodeBeamTransient(raw: unknown, input: BeamTransientInput, inputSha256: string): BeamTransientResult {
  const { plan } = translateBeamTransient(input);
  const history = plan.history;
  const damping = history.damping;
  const freeDofs = plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0);
  const steps = transientOutputSteps(history);
  const last = history.loadFactor[history.loadFactor.length - 1].timeS;
  if (!/^[0-9a-f]{64}$/u.test(inputSha256) || !record(raw)
    || (damping === 'none'
      ? raw.schema !== 'pointercad-oofem-transient-result/1' || 'damping' in raw || 'dissipatedEnergyJ' in raw
      : raw.schema !== 'pointercad-oofem-transient-result/2' || !rayleigh(raw.damping)
        || raw.damping.massCoefficientPerS !== damping.massCoefficientPerS
        || raw.damping.stiffnessCoefficientS !== damping.stiffnessCoefficientS
        || !nonnegative(raw.dissipatedEnergyJ)
        || (damping.massCoefficientPerS === 0 && damping.stiffnessCoefficientS === 0 && raw.dissipatedEnergyJ !== 0))
    || raw.meshNodes !== plan.nodes.length || raw.meshElements !== plan.members.length
    || raw.freeDofs !== freeDofs || raw.normalizationLengthM !== plan.normalizationLengthM
    || !errorBound(raw.maximumEquilibriumResidual) || !errorBound(raw.maximumEnergyBalanceError)
    || !nonnegative(raw.peakDisplacementM) || !nonnegative(raw.peakRotationRad)
    || !denseArray(raw.samples) || raw.samples.length !== steps.length) {
    throw new Error('Invalid transient result metadata, equilibrium or energy balance');
  }
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  let peakDisplacement = 0;
  let peakRotation = 0;
  const samples = raw.samples.map((sample: unknown, index: number): TransientSample => {
    const time = index === 0 ? 0 : history.timeStepS * steps[index];
    const factor = transientLoadFactor(history.loadFactor, Math.min(time, last));
    if (!record(sample) || sample.timeS !== time || typeof sample.loadFactor !== 'number' || !Number.isFinite(sample.loadFactor)
      || Math.abs(sample.loadFactor - factor) > 1e-12 * Math.max(1, Math.abs(factor))
      || !denseArray(sample.nodes) || sample.nodes.length !== original.length) {
      throw new Error('Invalid transient sample time, load factor or node count');
    }
    const nodes = sample.nodes.map((node: unknown, nodeIndex: number): TransientNodeResponse => {
      const expected = original[nodeIndex];
      if (!record(node) || node.number !== expected.number || Object.keys(node).length !== 1 + responseFields.length) {
        throw new Error('Invalid transient node');
      }
      const read = (name: typeof responseFields[number]): Vector3 => {
        const item = node[name];
        if (!vector(item)) throw new Error('Invalid transient node or non-finite response');
        return [item[0], item[1], item[2]];
      };
      const displacementM = read('displacementM');
      const rotationRad = read('rotationRad');
      const velocityMPerS = read('velocityMPerS');
      const angularVelocityRadPerS = read('angularVelocityRadPerS');
      const accelerationMPerS2 = read('accelerationMPerS2');
      const angularAccelerationRadPerS2 = read('angularAccelerationRadPerS2');
      for (const [translation, rotation] of [[displacementM, rotationRad], [velocityMPerS, angularVelocityRadPerS],
        [accelerationMPerS2, angularAccelerationRadPerS2]] as const) {
        if (expected.restrained.some((fixed, axis) => fixed && [...translation, ...rotation][axis] !== 0)) {
          throw new Error('Transient response violates a prescribed support');
        }
      }
      if (index === 0 && [...displacementM, ...rotationRad, ...velocityMPerS, ...angularVelocityRadPerS]
        .some(component => component !== 0)) {
        throw new Error('Transient response does not start from rest');
      }
      peakDisplacement = Math.max(peakDisplacement, Math.hypot(...displacementM));
      peakRotation = Math.max(peakRotation, Math.hypot(...rotationRad));
      return { solverNode: expected.number, nodeId: expected.id, displacementM, rotationRad, velocityMPerS,
        angularVelocityRadPerS, accelerationMPerS2, angularAccelerationRadPerS2 };
    });
    return { timeS: time, loadFactor: sample.loadFactor, nodes };
  });
  // A peak is one node's magnitude at one integration step: it bounds every returned sample and, when its
  // step is sampled at an original node, equals that sample's magnitude (never a norm of mixed-time maxima).
  const gridStep = (time: unknown): number | null => {
    if (typeof time !== 'number' || !Number.isFinite(time)) return null;
    const step = Math.round(time / history.timeStepS);
    return step >= 0 && step <= history.stepCount && (step === 0 ? 0 : history.timeStepS * step) === time ? step : null;
  };
  const checkPeak = (value: unknown, time: unknown, node: unknown, observed: number,
    select: (response: TransientNodeResponse) => Vector3): void => {
    const step = gridStep(time);
    if (!nonnegative(value) || step === null || typeof node !== 'number' || !Number.isSafeInteger(node)
      || !plan.nodes.some(row => row.number === node)
      || (value === 0 ? step !== 0 || node !== plan.nodes[0].number : step === 0)) {
      throw new Error('Invalid transient peak value, time or node');
    }
    if (observed > value * (1 + 1e-12)) throw new Error('Transient peak response is smaller than a returned sample');
    const sampleIndex = steps.indexOf(step);
    const nodeIndex = original.findIndex(row => row.number === node);
    if (value > 0 && sampleIndex >= 0 && nodeIndex >= 0) {
      const sampled = Math.hypot(...select(samples[sampleIndex].nodes[nodeIndex]));
      if (Math.abs(sampled - value) > 1e-12 * value) throw new Error('Transient peak differs from its own sample');
    }
  };
  checkPeak(raw.peakDisplacementM, raw.peakDisplacementTimeS, raw.peakDisplacementSolverNode, peakDisplacement,
    response => response.displacementM);
  checkPeak(raw.peakRotationRad, raw.peakRotationTimeS, raw.peakRotationSolverNode, peakRotation,
    response => response.rotationRad);
  if (typeof raw.peakDisplacementM !== 'number' || typeof raw.peakDisplacementTimeS !== 'number'
    || typeof raw.peakDisplacementSolverNode !== 'number' || typeof raw.peakRotationRad !== 'number'
    || typeof raw.peakRotationTimeS !== 'number' || typeof raw.peakRotationSolverNode !== 'number') {
    throw new Error('Invalid transient peak value, time or node');
  }
  // Build the discriminated metadata explicitly; a stale /1 worker cannot satisfy a Rayleigh request.
  const metadata = damping === 'none' ? {
    method: 'oofem-beam3d-matrices-newmark-average-acceleration/1' as const,
    scope: 'linear-elastic-undamped-small-displacement-nodal-loads' as const,
  } : {
    method: 'oofem-beam3d-matrices-newmark-average-acceleration/2' as const,
    scope: 'linear-elastic-rayleigh-small-displacement-nodal-loads' as const,
    damping: { ...damping }, dissipatedEnergyJ: Number(raw.dissipatedEnergyJ),
  };
  return {
    kind: 'oofem-beam-transient-3d', ...metadata, nativeTransientSolver: false,
    analysisId: input.geometry.id, analysisRevision: input.geometry.revision, source: input.geometry.source,
    inputSha256, timeStepS: history.timeStepS, stepCount: history.stepCount,
    normalizationLengthM: plan.normalizationLengthM, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    freeDofs, maximumEquilibriumResidual: raw.maximumEquilibriumResidual,
    maximumEnergyBalanceError: raw.maximumEnergyBalanceError, peakDisplacementM: raw.peakDisplacementM,
    peakDisplacementTimeS: raw.peakDisplacementTimeS, peakDisplacementSolverNode: raw.peakDisplacementSolverNode,
    peakRotationRad: raw.peakRotationRad, peakRotationTimeS: raw.peakRotationTimeS,
    peakRotationSolverNode: raw.peakRotationSolverNode, samples, structuralCertification: false,
  };
}

export function isBeamTransientResult(value: unknown): value is BeamTransientResult {
  if (!record(value) || value.kind !== 'oofem-beam-transient-3d'
    || !(value.method === 'oofem-beam3d-matrices-newmark-average-acceleration/1'
      ? value.scope === 'linear-elastic-undamped-small-displacement-nodal-loads'
        && !('damping' in value) && !('dissipatedEnergyJ' in value)
      : value.method === 'oofem-beam3d-matrices-newmark-average-acceleration/2'
        && value.scope === 'linear-elastic-rayleigh-small-displacement-nodal-loads'
        && rayleigh(value.damping) && nonnegative(value.dissipatedEnergyJ)
        && (value.damping.massCoefficientPerS !== 0 || value.damping.stiffnessCoefficientS !== 0
          || value.dissipatedEnergyJ === 0))
    || value.nativeTransientSolver !== false || value.structuralCertification !== false
    || typeof value.analysisId !== 'string' || typeof value.analysisRevision !== 'number'
    || !Number.isSafeInteger(value.analysisRevision) || value.analysisRevision < 0
    || !record(value.source) || typeof value.source.documentId !== 'string'
    || typeof value.source.documentRevision !== 'number' || !Number.isSafeInteger(value.source.documentRevision)
    || value.source.documentRevision < 0 || typeof value.source.geometryRevision !== 'string'
    || typeof value.inputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.inputSha256)
    || !positive(value.timeStepS) || !positive(value.stepCount) || !Number.isSafeInteger(value.stepCount)
    || value.stepCount > 4000 || !positive(value.normalizationLengthM)
    || !positive(value.meshNodes) || !Number.isSafeInteger(value.meshNodes) || value.meshNodes > 128
    || !positive(value.meshElements) || !Number.isSafeInteger(value.meshElements)
    || !positive(value.freeDofs) || !Number.isSafeInteger(value.freeDofs)
    || !errorBound(value.maximumEquilibriumResidual) || !errorBound(value.maximumEnergyBalanceError)
    || !nonnegative(value.peakDisplacementM) || !nonnegative(value.peakRotationRad)
    || !nonnegative(value.peakDisplacementTimeS) || !nonnegative(value.peakRotationTimeS)
    || !positive(value.peakDisplacementSolverNode) || !Number.isSafeInteger(value.peakDisplacementSolverNode)
    || !positive(value.peakRotationSolverNode) || !Number.isSafeInteger(value.peakRotationSolverNode)
    || value.peakDisplacementSolverNode > value.meshNodes || value.peakRotationSolverNode > value.meshNodes
    || !denseArray(value.samples) || value.samples.length < 2 || value.samples.length > 101) return false;
  return value.samples.every((sample: unknown) => record(sample) && nonnegative(sample.timeS)
    && typeof sample.loadFactor === 'number' && Number.isFinite(sample.loadFactor)
    && denseArray(sample.nodes) && sample.nodes.length >= 2 && sample.nodes.length <= 128
    && sample.nodes.every((node: unknown) => record(node) && positive(node.solverNode)
      && Number.isSafeInteger(node.solverNode) && typeof node.nodeId === 'string'
      && responseFields.every(name => vector(node[name]))));
}

/** Compare the complete decoded result, ignoring only object property insertion order.
 * Same rule as the private helper of bucklingResults.ts, kept local so that file is unchanged. */
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

/** True only for a result decoded from exactly this input and digest; stale or foreign results are rejected. */
export function transientResultMatches(value: unknown, input: BeamTransientInput, hash: string): value is BeamTransientResult {
  if (!isBeamTransientResult(value)) return false;
  try {
    const damped = value.method === 'oofem-beam3d-matrices-newmark-average-acceleration/2';
    const decoded = decodeBeamTransient({
      schema: damped ? 'pointercad-oofem-transient-result/2' : 'pointercad-oofem-transient-result/1',
      ...(damped ? { damping: value.damping, dissipatedEnergyJ: value.dissipatedEnergyJ } : {}),
      normalizationLengthM: value.normalizationLengthM, meshNodes: value.meshNodes, meshElements: value.meshElements,
      freeDofs: value.freeDofs, maximumEquilibriumResidual: value.maximumEquilibriumResidual,
      maximumEnergyBalanceError: value.maximumEnergyBalanceError, peakDisplacementM: value.peakDisplacementM,
      peakDisplacementTimeS: value.peakDisplacementTimeS, peakDisplacementSolverNode: value.peakDisplacementSolverNode,
      peakRotationRad: value.peakRotationRad, peakRotationTimeS: value.peakRotationTimeS,
      peakRotationSolverNode: value.peakRotationSolverNode,
      samples: value.samples.map(sample => ({ timeS: sample.timeS, loadFactor: sample.loadFactor,
        nodes: sample.nodes.map(node => ({ number: node.solverNode, displacementM: node.displacementM,
          rotationRad: node.rotationRad, velocityMPerS: node.velocityMPerS,
          angularVelocityRadPerS: node.angularVelocityRadPerS, accelerationMPerS2: node.accelerationMPerS2,
          angularAccelerationRadPerS2: node.angularAccelerationRadPerS2 })) })),
    }, input, hash);
    return sameResultStructure(value, decoded);
  } catch { return false; }
}
