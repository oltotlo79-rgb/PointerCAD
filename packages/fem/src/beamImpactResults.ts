import type { Vector3 } from './analysisModel.js';
import {
  BEAM_IMPACT_SCOPE, type BeamImpactContactPeak, type BeamImpactContactSample, type BeamImpactInput,
  type BeamImpactNodeSample, type BeamImpactResult, type BeamImpactSample,
} from './beamImpactModel.js';
import { decodeImpactInterior } from './beamImpactInterior.js';
import { translateBeamImpact } from './beamImpactTranslation.js';

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
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function nonnegative(value: unknown): value is number {
  return finite(value) && value >= 0;
}
/** beamImpact.py integrate refuses above 1e-8; the decoder enforces the same stated bound. */
function errorBound(value: unknown): value is number {
  return nonnegative(value) && value <= 1e-8;
}
function vector(value: unknown): value is Vector3 {
  return Array.isArray(value) && value.length === 3 && Reflect.ownKeys(value).length === 4
    && [0, 1, 2].every(index => Object.hasOwn(value, index) && finite(value[index]));
}
function exactKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
/** |a - b| <= tolerance * reference for finite values, compared after dividing by the largest magnitude so that no
 * sum, difference or tolerance product overflows (a false pass against Infinity is impossible). */
function close(a: number, b: number, tolerance: number, reference: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(reference));
  if (scale === 0) return true;
  return Math.abs(a / scale - b / scale) <= tolerance * (Math.abs(reference) / scale);
}
/** value <= limit * (1 + tolerance) for nonnegative finite values without forming an overflowing product. */
function notAbove(value: number, limit: number, tolerance: number): boolean {
  return value <= limit || value - limit <= tolerance * limit;
}
const nodeFields = ['number', 'displacementM', 'rotationRad', 'velocityMPerS', 'angularVelocityRadPerS'] as const;
const resultFields = ['schema', 'samples', 'normalizationLengthM', 'meshNodes', 'meshElements', 'freeDofs',
  'initialEnergyJ', 'maximumEnergyBalanceError', 'maximumMomentumResidual', 'factorizationsUsed', 'contactPeaks'] as const;

/** Output steps of solve_impact_plan: 0, every outputEvery-th step and the last step. */
export function impactOutputSteps(stepCount: number, outputEvery: number): number[] {
  const steps = [0];
  for (let index = 1; index <= stepCount; index += 1) {
    if (index % outputEvery === 0 || index === stepCount) steps.push(index);
  }
  return steps;
}

/**
 * Strict decoder of pointercad-oofem-impact-result/1 (beamImpact.py solve_impact_plan) against the input it was
 * prepared from. Checks exact own metadata, grid times, rest displacement and the input initial velocity at t = 0,
 * supports, gaps from displacements, finite impulses equal to h * force, conserved energy (no external work), the
 * stated balance bounds and peak consistency, every comparison scaled so that no intermediate overflows. Scope stays
 * elastic, frictionless, normal, fixed-plane contact.
 */
export function decodeBeamImpact(raw: unknown, input: BeamImpactInput, inputSha256: string): BeamImpactResult {
  const { plan } = translateBeamImpact(input);
  const { timeStepS, stepCount, outputEvery } = plan.impact;
  const freeDofs = plan.nodes.reduce((sum, node) => sum + node.restrained.filter(value => !value).length, 0);
  const steps = impactOutputSteps(stepCount, outputEvery);
  if (!/^[0-9a-f]{64}$/u.test(inputSha256) || !record(raw)
    || !(exactKeys(raw, resultFields) || exactKeys(raw, [...resultFields, 'elements']))
    || raw.schema !== 'pointercad-oofem-impact-result/1' || raw.meshNodes !== plan.nodes.length
    || raw.meshElements !== plan.members.length || raw.freeDofs !== freeDofs
    || raw.normalizationLengthM !== plan.normalizationLengthM
    || !finite(raw.initialEnergyJ) || raw.initialEnergyJ <= 0
    || !errorBound(raw.maximumEnergyBalanceError) || !errorBound(raw.maximumMomentumResidual)
    || typeof raw.factorizationsUsed !== 'number' || !Number.isSafeInteger(raw.factorizationsUsed)
    || raw.factorizationsUsed < 0 || raw.factorizationsUsed > 200_000
    || !denseArray(raw.samples) || raw.samples.length !== steps.length
    || !denseArray(raw.contactPeaks) || raw.contactPeaks.length !== plan.impact.contacts.length) {
    throw new Error('impact-result: invalid metadata, balances or sample count');
  }
  const initialEnergy = raw.initialEnergyJ;
  // The optional solver mesh fields come together: 'elements' on the reply and 'mesh' on every sample.
  const withMesh = Object.hasOwn(raw, 'elements');
  const sampleFields = withMesh ? ['step', 'timeS', 'energyJ', 'nodes', 'contacts', 'mesh'] : ['step', 'timeS', 'energyJ', 'nodes', 'contacts'];
  const original = plan.nodes.slice(0, plan.originalNodeCount);
  const contactIds = input.contacts.map(contact => contact.nodeId);
  const samples = raw.samples.map((sample: unknown, index: number): BeamImpactSample => {
    const step = steps[index];
    const time = step === 0 ? 0 : timeStepS * step;
    // Energy is conserved (zero external work): |E - E0| <= 1e-8 (E + E0), evaluated after scaling by max(E, E0).
    const energyScale = record(sample) && nonnegative(sample.energyJ) ? Math.max(sample.energyJ, initialEnergy) : 0;
    if (!record(sample) || !exactKeys(sample, sampleFields)
      || sample.step !== step || sample.timeS !== time || !nonnegative(sample.energyJ)
      || Math.abs(sample.energyJ / energyScale - initialEnergy / energyScale)
        > 1e-8 * (sample.energyJ / energyScale + initialEnergy / energyScale)
      || !denseArray(sample.nodes) || sample.nodes.length !== original.length
      || !denseArray(sample.contacts) || sample.contacts.length !== plan.impact.contacts.length) {
      throw new Error('impact-result: invalid sample step, time, energy or counts');
    }
    const nodes = sample.nodes.map((node: unknown, nodeIndex: number): BeamImpactNodeSample => {
      const expected = original[nodeIndex];
      if (!record(node) || !exactKeys(node, nodeFields) || node.number !== expected.number
        || !vector(node.displacementM) || !vector(node.rotationRad) || !vector(node.velocityMPerS)
        || !vector(node.angularVelocityRadPerS)) {
        throw new Error('impact-result: invalid node response');
      }
      const displacementM: Vector3 = [node.displacementM[0], node.displacementM[1], node.displacementM[2]];
      const rotationRad: Vector3 = [node.rotationRad[0], node.rotationRad[1], node.rotationRad[2]];
      const velocityMPerS: Vector3 = [node.velocityMPerS[0], node.velocityMPerS[1], node.velocityMPerS[2]];
      const angularVelocityRadPerS: Vector3 = [node.angularVelocityRadPerS[0], node.angularVelocityRadPerS[1],
        node.angularVelocityRadPerS[2]];
      for (const [translation, rotation] of [[displacementM, rotationRad], [velocityMPerS, angularVelocityRadPerS]] as const) {
        if (expected.restrained.some((fixed, axis) => fixed && [...translation, ...rotation][axis] !== 0)) {
          throw new Error('impact-result: response violates a prescribed support');
        }
      }
      if (step === 0) {
        const initial = plan.impact.initialVelocity[nodeIndex];
        const amplitude = Math.max(Math.abs(initial[0]), Math.abs(initial[1]), Math.abs(initial[2]));
        if ([...displacementM, ...rotationRad, ...angularVelocityRadPerS].some(component => component !== 0)
          || velocityMPerS.some((component, axis) => !close(component, initial[axis], 1e-12, amplitude))) {
          throw new Error('impact-result: the response does not start at rest with the input initial velocity');
        }
      }
      return { solverNode: expected.number, nodeId: expected.id, displacementM, rotationRad, velocityMPerS,
        angularVelocityRadPerS };
    });
    const contacts = sample.contacts.map((contact: unknown, contactIndex: number): BeamImpactContactSample => {
      const planned = plan.impact.contacts[contactIndex];
      if (!record(contact) || !exactKeys(contact, ['gapM', 'intervalForceN', 'impulseNs']) || !finite(contact.gapM)) {
        throw new Error('impact-result: invalid contact sample');
      }
      const u = nodes[original.findIndex(node => node.number === planned.node)].displacementM;
      // g = gapM - n . u compared after dividing every term by the largest magnitude (no overflowing dot product).
      const scale = Math.max(planned.gapM, Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2]), Math.abs(contact.gapM));
      if (scale > 0) {
        const expected = planned.gapM / scale - (planned.directionUnit[0] * (u[0] / scale)
          + planned.directionUnit[1] * (u[1] / scale) + planned.directionUnit[2] * (u[2] / scale));
        if (!Number.isFinite(expected) || Math.abs(contact.gapM / scale - expected) > 1e-9) {
          throw new Error('impact-result: contact gap differs from the node displacement');
        }
      }
      if (step === 0) {
        if (contact.intervalForceN !== null || contact.impulseNs !== null || contact.gapM !== planned.gapM) {
          throw new Error('impact-result: invalid initial contact state');
        }
        return { nodeId: contactIds[contactIndex], gapM: contact.gapM, intervalForceN: null, impulseNs: null };
      }
      if (!nonnegative(contact.intervalForceN) || !nonnegative(contact.impulseNs)
        || contact.impulseNs !== timeStepS * contact.intervalForceN) {
        throw new Error('impact-result: invalid interval force or impulse');
      }
      return { nodeId: contactIds[contactIndex], gapM: contact.gapM, intervalForceN: contact.intervalForceN,
        impulseNs: contact.impulseNs };
    });
    return { step, timeS: time, energyJ: sample.energyJ, nodes, contacts };
  });
  const contactPeaks = raw.contactPeaks.map((peak: unknown, contactIndex: number): BeamImpactContactPeak => {
    if (!record(peak) || !exactKeys(peak, ['intervalForceN', 'timeS', 'totalImpulseNs'])
      || !nonnegative(peak.intervalForceN) || !nonnegative(peak.totalImpulseNs) || !finite(peak.timeS)) {
      throw new Error('impact-result: invalid contact peak');
    }
    const peakStep = Math.round(peak.timeS / timeStepS);
    if (peakStep < 1 || peakStep > stepCount || timeStepS * peakStep !== peak.timeS) {
      throw new Error('impact-result: contact peak time is not an integration step');
    }
    const impulses: number[] = [];
    for (const sample of samples) {
      const force = sample.contacts[contactIndex].intervalForceN;
      const impulse = sample.contacts[contactIndex].impulseNs;
      if (force !== null && !notAbove(force, peak.intervalForceN, 1e-12)) {
        throw new Error('impact-result: contact peak is smaller than a sample');
      }
      if (sample.step === peakStep && force !== peak.intervalForceN) throw new Error('impact-result: contact peak differs from its own sample');
      if (impulse !== null) impulses.push(impulse);
    }
    // The sampled impulses are a subset of all nonnegative interval impulses: their sum cannot exceed the total.
    const impulseScale = Math.max(peak.totalImpulseNs, ...impulses);
    const sampled = impulseScale === 0 ? 0 : impulses.reduce((sum, impulse) => sum + impulse / impulseScale, 0);
    const total = impulseScale === 0 ? 0 : peak.totalImpulseNs / impulseScale;
    if (!notAbove(sampled, total, 1e-12)) throw new Error('impact-result: total impulse is smaller than the sampled impulses');
    return { nodeId: contactIds[contactIndex], intervalForceN: peak.intervalForceN, timeS: peak.timeS,
      totalImpulseNs: peak.totalImpulseNs };
  });
  const decoded: BeamImpactResult = {
    kind: 'oofem-beam-impact-3d', method: 'oofem-beam3d-matrices-midpoint-discrete-gradient-contact/1',
    scope: BEAM_IMPACT_SCOPE, nativeImpactSolver: false, analysisId: input.geometry.id,
    analysisRevision: input.geometry.revision, source: input.geometry.source, inputSha256, timeStepS, stepCount,
    normalizationLengthM: plan.normalizationLengthM, samples, contactPeaks, initialEnergyJ: initialEnergy,
    maximumEnergyBalanceError: raw.maximumEnergyBalanceError, maximumMomentumResidual: raw.maximumMomentumResidual,
    factorizationsUsed: raw.factorizationsUsed, freeDofs, meshNodes: plan.nodes.length, meshElements: plan.members.length,
    structuralCertification: false,
  };
  return withMesh ? { ...decoded, interior: decodeImpactInterior(raw.elements,
    raw.samples.map((sample: unknown) => record(sample) ? sample.mesh : undefined), input, samples) } : decoded;
}
