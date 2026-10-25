import type { SolidBucklingInput, SolidBucklingResult } from './solidBucklingModel.js';
import { decodeSolidBuckling, SOLID_BUCKLING_METHOD } from './solidBucklingResults.js';
import { SOLID_BUCKLING_MAX_MODES } from './solidBucklingTranslation.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function bound(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e-8;
}
function vector(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

/** Structural shape of a decoded result crossing the Worker boundary; identity is checked by solidBucklingResultMatches. */
export function isSolidBucklingResult(value: unknown): value is SolidBucklingResult {
  if (!record(value) || value.kind !== 'oofem-solid-tet4-buckling' || value.method !== SOLID_BUCKLING_METHOD
    || value.scope !== 'linear-elastic-prestress-bifurcation' || value.units !== 'N-mm-MPa'
    || value.structuralCertification !== false || !record(value.source) || typeof value.source.documentId !== 'string'
    || typeof value.source.revision !== 'number' || !Number.isSafeInteger(value.source.revision)
    || typeof value.source.meshKey !== 'string' || typeof value.inputSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.inputSha256) || typeof value.freeDofs !== 'number'
    || !Number.isSafeInteger(value.freeDofs) || value.freeDofs < 1 || !bound(value.referenceEquilibriumResidual)
    || !bound(value.maximumElementInitialStressError) || !Array.isArray(value.modes) || value.modes.length < 1
    || value.modes.length > SOLID_BUCKLING_MAX_MODES) return false;
  return value.modes.every((mode: unknown) => record(mode) && typeof mode.number === 'number' && Number.isSafeInteger(mode.number)
    && typeof mode.loadFactor === 'number' && Number.isFinite(mode.loadFactor) && mode.loadFactor > 0
    && bound(mode.normalizedResidual) && Array.isArray(mode.shape) && mode.shape.length > 0 && mode.shape.every(vector));
}

/** Compare the complete decoded result, ignoring only object property insertion order. */
function sameStructure(value: unknown, expected: unknown): boolean {
  if (Array.isArray(value) || Array.isArray(expected)) {
    if (!Array.isArray(value) || !Array.isArray(expected) || value.length !== expected.length
      || Reflect.ownKeys(value).length !== value.length + 1 || Reflect.ownKeys(expected).length !== expected.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index) || !Object.hasOwn(expected, index) || !sameStructure(value[index], expected[index])) return false;
    }
    return true;
  }
  if (record(value) && record(expected)) {
    const keys = Reflect.ownKeys(value);
    return keys.length === Reflect.ownKeys(expected).length
      && keys.every(key => typeof key === 'string' && Object.hasOwn(expected, key) && sameStructure(value[key], expected[key]));
  }
  return value === expected;
}

/** A reply for another revision, mesh, load set, mode count or digest fails the strict re-decode against this input. */
export function solidBucklingResultMatches(value: unknown, input: SolidBucklingInput, hash: string): value is SolidBucklingResult {
  if (!isSolidBucklingResult(value)) return false;
  try {
    const decoded = decodeSolidBuckling({ schema: 'pointercad-solid-tet4-buckling-native/1', source: value.source,
      freeDofs: value.freeDofs, referenceEquilibriumResidual: value.referenceEquilibriumResidual,
      maximumElementInitialStressError: value.maximumElementInitialStressError,
      modes: value.modes.map(mode => ({ number: mode.number, loadFactor: mode.loadFactor,
        normalizedResidual: mode.normalizedResidual, shape: mode.shape })) }, input, hash);
    return sameStructure(value, decoded);
  } catch { return false; }
}
