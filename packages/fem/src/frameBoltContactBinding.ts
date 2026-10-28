import { decodeFrameBoltContact, type FrameBoltContactInput } from './beamBoltContact.js';

export type FrameBoltContactResult = ReturnType<typeof decodeFrameBoltContact>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** 参照する前にdata descriptorだけを認め、getterを評価しない。 */
function data(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 10000
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (descriptor === undefined || !('value' in descriptor) || !data(descriptor.value, depth + 1)) return false;
    }
    return true;
  }
  if (!record(value)) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && descriptor !== undefined && 'value' in descriptor && data(descriptor.value, depth + 1);
  });
}

/** 軽い識別だけ。数値・入力との一致を保証するには下の完全照合が必要。 */
export function isFrameBoltContactResult(value: unknown): value is FrameBoltContactResult {
  try {
    if (!record(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !('value' in (Object.getOwnPropertyDescriptor(value, key) ?? {})))) return false;
    return value.kind === 'frame-bolt-contact' && value.schema === 'pointercad-frame-bolt-contact-result/1'
      && value.structuralCertification === false && value.nativeContactSolver === false
      && typeof value.inputSha256 === 'string' && /^[0-9a-f]{64}$/u.test(value.inputSha256)
      && record(value.contact) && Array.isArray(value.states) && value.states.length >= 1 && value.states.length <= 32;
  } catch { return false; }
}

function equal(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((item: unknown, index) => equal(item, expected[index]));
  }
  if (record(actual) && record(expected)) {
    const keys = Reflect.ownKeys(actual);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key) && equal(actual[key], expected[key]));
  }
  return actual === expected;
}

/** 所有側が元inputから確定したdigestで再decodeし、導出欄も含め全構造を厳密比較する。 */
export function frameBoltContactResultMatches(value: unknown, input: FrameBoltContactInput, hash: string): value is FrameBoltContactResult {
  try {
    if (!isFrameBoltContactResult(value) || !data(value)) return false;
    const contact = value.contact;
    const numeric = { schema: contact.schema, method: contact.method, freeDofs: contact.freeDofs,
      meshNodes: contact.meshNodes, meshElements: contact.meshElements, momentLengthM: contact.momentLengthM,
      pivotLimit: contact.pivotLimit, states: contact.states };
    const states = value.states.map(state => ({ loadFactor: state.loadFactor, boltId: state.boltId, member: state.member,
      forceOnAN: state.forceOnAN, forceOnBN: state.forceOnBN, momentOnANm: state.momentOnANm, momentOnBNm: state.momentOnBNm,
      axialForceN: state.axialForceN, shearYN: state.shearYN, shearZN: state.shearZN, bendingYNm: state.bendingYNm,
      bendingZNm: state.bendingZNm, elasticEnergyJ: state.elasticEnergyJ, transverseEnergyJ: state.transverseEnergyJ }));
    const decoded = decodeFrameBoltContact({ schema: value.schema, inputSha256: value.inputSha256, contact: numeric, states }, input, hash);
    return equal(value, decoded);
  } catch { return false; }
}
