import { decodeBeamWeldSpanContact, translateBeamWeldSpanContact,
  type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';

export type BeamWeldSpanContactResult = Awaited<ReturnType<typeof decodeBeamWeldSpanContact>>;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** Preliminary discrimination only; never read a top-level accessor. */
export function isBeamWeldSpanContactResult(value: unknown): value is BeamWeldSpanContactResult {
  try {
    if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))) return false;
    return value.kind === 'oofem-beam-weld-span-contact' && value.schema === 'pointercad-weld-span-result/1'
      && value.structuralCertification === false && typeof value.inputSha256 === 'string'
      && /^[0-9a-f]{64}$/u.test(value.inputSha256) && record(value.contact)
      && Array.isArray(value.states) && value.states.length >= 1 && value.states.length <= 32;
  } catch { return false; }
}
function data(value: unknown): boolean {
  let budget = 4_000_000;
  function check(v: unknown, depth: number): boolean {
    if (--budget < 0 || depth > 24) return false;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 1e30;
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 4096 || Reflect.ownKeys(v).length !== v.length+1) return false;
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (d === undefined || !('value' in d) || !d.enumerable || !check(d.value, depth+1)) return false;
      }
      return true;
    }
    return record(v) && Reflect.ownKeys(v).every(key => {
      const d = Object.getOwnPropertyDescriptor(v, key);
      return typeof key === 'string' && d !== undefined && 'value' in d && d.enumerable && check(d.value, depth+1);
    });
  }
  return check(value, 0);
}
function equal(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((v: unknown, i) => equal(v, expected[i]));
  }
  if (record(actual) && record(expected)) {
    const keys = Reflect.ownKeys(actual);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key) && equal(actual[key], expected[key]));
  }
  return actual === expected;
}
/** Async because the dedicated decoder verifies the actual canonical input digest, not merely its shape. */
export async function beamWeldSpanContactResultMatches(value: unknown, input: BeamWeldSpanContactInput, hash: string): Promise<boolean> {
  try {
    if (!data(value) || !isBeamWeldSpanContactResult(value)) return false;
    const owned = structuredClone(value), prepared = translateBeamWeldSpanContact(input), c = owned.contact;
    const numeric = { schema: c.schema, method: c.method, freeDofs: c.freeDofs, meshNodes: c.meshNodes,
      meshElements: c.meshElements, momentLengthM: c.momentLengthM, pivotLimit: c.pivotLimit, states: c.states };
    const decoded = await decodeBeamWeldSpanContact({ schema: owned.schema, contact: numeric, states: owned.states }, prepared.input, hash);
    return equal(owned, decoded);
  } catch { return false; }
}
