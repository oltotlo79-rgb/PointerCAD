import { decodeBeamJointInitialStrain, type BeamJointInitialStrainInput, type BeamJointInitialStrainResult } from './beamJointInitialStrain.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Preliminary protocol discrimination only; the owning client performs complete input-bound decoding. */
export function isBeamJointInitialStrainResult(value: unknown): value is BeamJointInitialStrainResult {
  return record(value) && value.kind === 'oofem-beam-joint-initial-strain'
    && value.schema === 'pointercad-joint-initial-strain-result/1' && value.structuralCertification === false
    && typeof value.inputSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.inputSha256)
    && record(value.contact) && Array.isArray(value.states) && value.states.length >= 1 && value.states.length <= 32;
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
export function beamJointInitialStrainResultMatches(value: unknown, input: BeamJointInitialStrainInput, hash: string): value is BeamJointInitialStrainResult {
  if (!isBeamJointInitialStrainResult(value)) return false;
  try {
    return equal(value, decodeBeamJointInitialStrain({ schema: value.schema, contact: value.contact, states: value.states }, input, hash));
  } catch { return false; }
}
