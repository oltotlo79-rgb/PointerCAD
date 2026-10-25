import { solidArray, solidNumber, solidRecord, solidVector } from './solidAnalysisTranslation.js';
import type { SolidModalInput, SolidModalResult } from './solidModalModel.js';
import { decodeSolidModal, SOLID_MODAL_METHOD } from './solidModalResults.js';
import { SOLID_MODAL_LIMITS } from './solidModalTranslation.js';

const RESULT_FIELDS = ['kind', 'method', 'source', 'inputSha256', 'units', 'structuralCertification', 'applicability', 'nodes',
  'fixed', 'rigidBodyModes', 'freeDofs', 'totalMassT', 'modes', 'maximumMassOrthogonalityError', 'maximumRigidMotionResidual',
  'maximumElementMassError', 'reservedNumericBytes', 'independentMaximumResidual', 'independentMaximumOrthogonalityError'];
const MODE_FIELDS = ['number', 'eigenvaluePerSecondSquared', 'frequencyHz', 'normalizedResidual', 'massNormalizedShapePerSqrtT'];
function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) if (!Object.hasOwn(left, i) || !Object.hasOwn(right, i) || !same(left[i], right[i])) return false;
    return true;
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const a = Object.entries(left), b = new Map(Object.entries(right));
    return a.length === b.size && a.every(([key, value]) => b.has(key) && same(value, b.get(key)));
  }
  return left === right;
}
function bounded(value: unknown, maximum: number): boolean {
  const number = solidNumber(value);
  return number >= 0 && number <= maximum;
}

/** Shape gate for a structured-clone reply; solidModalResultMatches additionally re-decodes against the input. */
export function isSolidModalResult(value: unknown): value is SolidModalResult {
  try {
    const row = solidRecord(value, RESULT_FIELDS);
    if (row.kind !== 'oofem-solid-tet4-modal' || row.method !== SOLID_MODAL_METHOD || row.units !== 'N-mm-MPa-t-s'
      || row.structuralCertification !== false || (row.applicability !== 'supported' && row.applicability !== 'free-free')
      || typeof row.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.inputSha256)
      || row.rigidBodyModes !== (row.applicability === 'free-free' ? 6 : 0)) return false;
    const source = solidRecord(row.source, ['documentId', 'revision', 'meshKey']);
    if (typeof source.documentId !== 'string' || typeof source.meshKey !== 'string' || typeof source.revision !== 'number'
      || !Number.isSafeInteger(source.revision) || source.revision < 0) return false;
    const count = solidArray(row.nodes, SOLID_MODAL_LIMITS.nodes, 4).map(solidVector).length;
    const fixed = solidArray(row.fixed, count, count).map(flags => solidArray(flags, 3, 3));
    if (fixed.some(flags => flags.some(flag => typeof flag !== 'boolean'))) return false;
    const freeDofs = solidNumber(row.freeDofs), reserved = solidNumber(row.reservedNumericBytes);
    if (!Number.isSafeInteger(freeDofs) || freeDofs < 1 || freeDofs > 3 * count || !Number.isSafeInteger(reserved) || reserved <= 0
      || !(solidNumber(row.totalMassT) > 0)) return false;
    if (![row.maximumMassOrthogonalityError, row.independentMaximumResidual, row.independentMaximumOrthogonalityError]
      .every(error => bounded(error, 1e-8)) || !bounded(row.maximumRigidMotionResidual, 1e-10)
      || !bounded(row.maximumElementMassError, 1e-10)) return false;
    return solidArray(row.modes, SOLID_MODAL_LIMITS.modes, 1).every((value, index) => {
      const mode = solidRecord(value, MODE_FIELDS);
      return mode.number === index + 1 && solidNumber(mode.eigenvaluePerSecondSquared) > 0 && solidNumber(mode.frequencyHz) > 0
        && bounded(mode.normalizedResidual, 1e-8)
        && solidArray(mode.massNormalizedShapePerSqrtT, count, count).map(solidVector).length === count;
    });
  } catch { return false; }
}

/** Rebuild the native/2 reply from the stored values and decode it again against the current input and digest:
 * a stale revision, other mesh, changed material or tampered value is refused. Property order is irrelevant. */
export function solidModalResultMatches(value: unknown, input: SolidModalInput, hash: string): value is SolidModalResult {
  if (!isSolidModalResult(value) || value.inputSha256 !== hash) return false;
  try {
    const decoded = decodeSolidModal({ schema: 'pointercad-solid-tet4-modal-native/2', source: value.source,
      massMatrix: 'consistent', units: 'N-mm-MPa-t-s', modes: value.modes, totalMassT: value.totalMassT,
      rigidBodyModes: value.rigidBodyModes, freeDofs: value.freeDofs,
      maximumMassOrthogonalityError: value.maximumMassOrthogonalityError,
      maximumRigidMotionResidual: value.maximumRigidMotionResidual, maximumElementMassError: value.maximumElementMassError,
      reservedNumericBytes: value.reservedNumericBytes }, input, hash);
    return same(value, decoded);
  } catch { return false; }
}
