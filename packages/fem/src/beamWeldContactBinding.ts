import { decodeBeamWeldContact, type BeamWeldContactInput, type BeamWeldContactResult } from './beamWeldContact.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Preliminary protocol discrimination only; the owning client performs complete input-bound decoding. */
export function isBeamWeldContactResult(value: unknown): value is BeamWeldContactResult {
  return record(value) && value.kind === 'oofem-beam-weld-layer-contact'
    && value.schema === 'pointercad-weld-layer-result/1' && value.structuralCertification === false
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
export function beamWeldContactResultMatches(value: unknown, input: BeamWeldContactInput, hash: string): value is BeamWeldContactResult {
  if (!isBeamWeldContactResult(value)) return false;
  try {
    return equal(value, decodeBeamWeldContact({ schema: value.schema, contact: value.contact, states: value.states }, input, hash));
  } catch { return false; }
}
