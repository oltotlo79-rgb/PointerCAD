import { BEAM_IMPACT_SCOPE, type BeamImpactInput, type BeamImpactResult } from './beamImpactModel.js';
import { decodeBeamImpact } from './beamImpactResults.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Preliminary protocol discrimination only; the owning client performs complete input-bound decoding. */
export function isBeamImpactResult(value: unknown): value is BeamImpactResult {
  return record(value) && value.kind === 'oofem-beam-impact-3d'
    && value.method === 'oofem-beam3d-matrices-midpoint-discrete-gradient-contact/1'
    && value.scope === BEAM_IMPACT_SCOPE && value.nativeImpactSolver === false && value.structuralCertification === false
    && typeof value.inputSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.inputSha256)
    && Array.isArray(value.samples) && value.samples.length >= 2 && value.samples.length <= 101
    && Array.isArray(value.contactPeaks) && value.contactPeaks.length >= 1 && value.contactPeaks.length <= 64;
}
function equal(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length
      || Reflect.ownKeys(actual).length !== actual.length + 1) return false;
    return Array.from({ length: expected.length }, (_, i) => Object.hasOwn(actual, i) && equal(actual[i], expected[i])).every(Boolean);
  }
  if (record(actual) && record(expected)) {
    const keys = Reflect.ownKeys(actual);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key) && equal(actual[key], expected[key]));
  }
  return actual === expected;
}
/** True only for a result that re-decodes, from its own numbers, to exactly itself for this input and digest:
 * stale, foreign, forged or nonfinite replies are rejected by the strict decoder. */
export function beamImpactResultMatches(value: unknown, input: BeamImpactInput, hash: string): value is BeamImpactResult {
  if (!isBeamImpactResult(value)) return false;
  try {
    const raw = {
      schema: 'pointercad-oofem-impact-result/1',
      samples: value.samples.map((sample, index) => ({ step: sample.step, timeS: sample.timeS, energyJ: sample.energyJ,
        nodes: sample.nodes.map(node => ({ number: node.solverNode, displacementM: node.displacementM,
          rotationRad: node.rotationRad, velocityMPerS: node.velocityMPerS, angularVelocityRadPerS: node.angularVelocityRadPerS })),
        contacts: sample.contacts.map(contact => ({ gapM: contact.gapM, intervalForceN: contact.intervalForceN,
          impulseNs: contact.impulseNs })),
        ...(value.interior === undefined ? {} : { mesh: value.interior.mesh[index]?.map(node => ({ number: node.solverNode,
          displacementM: node.displacementM, rotationRad: node.rotationRad })) }) })),
      normalizationLengthM: value.normalizationLengthM, meshNodes: value.meshNodes, meshElements: value.meshElements,
      freeDofs: value.freeDofs, initialEnergyJ: value.initialEnergyJ,
      maximumEnergyBalanceError: value.maximumEnergyBalanceError, maximumMomentumResidual: value.maximumMomentumResidual,
      factorizationsUsed: value.factorizationsUsed,
      contactPeaks: value.contactPeaks.map(peak => ({ intervalForceN: peak.intervalForceN, timeS: peak.timeS,
        totalImpulseNs: peak.totalImpulseNs })),
      ...(value.interior === undefined ? {} : { elements: value.interior.elements.map(element => ({ number: element.element,
        nodes: [...element.solverNodes], globalStiffness: element.globalStiffness })) }),
    };
    return equal(value, decodeBeamImpact(raw, input, hash));
  } catch { return false; }
}
