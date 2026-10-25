import type { SolidVector3 } from './solidAnalysisModel.js';
import type { SolidBucklingInput, SolidBucklingMode, SolidBucklingResult } from './solidBucklingModel.js';
import { translateSolidBuckling } from './solidBucklingTranslation.js';

export const SOLID_BUCKLING_METHOD = 'oofem-ltrspace-initial-stress-eigh/1';
const ERROR_BOUND = 1e-8;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function errorBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= ERROR_BOUND;
}
function denseArray(value: unknown, length: number): value is unknown[] {
  return Array.isArray(value) && value.length === length && Reflect.ownKeys(value).length === length + 1
    && value.every((_, index) => Object.hasOwn(value, index));
}
function vector(value: unknown): value is SolidVector3 {
  return denseArray(value, 3) && value.every(item => typeof item === 'number' && Number.isFinite(item));
}

/** Strict decoder of the native reply; nothing is repaired, sorted or rescaled here. */
export function decodeSolidBuckling(raw: unknown, input: SolidBucklingInput, inputSha256: string): SolidBucklingResult {
  const { plan } = translateSolidBuckling(input);
  const source = plan.input.reference.source;
  if (!/^[0-9a-f]{64}$/u.test(inputSha256) || !record(raw)
    || !exactFields(raw, ['schema', 'source', 'freeDofs', 'referenceEquilibriumResidual', 'maximumElementInitialStressError', 'modes'])
    || raw.schema !== 'pointercad-solid-tet4-buckling-native/1' || !record(raw.source)
    || !exactFields(raw.source, ['documentId', 'revision', 'meshKey']) || raw.source.documentId !== source.documentId
    || raw.source.revision !== source.revision || raw.source.meshKey !== source.meshKey
    || raw.freeDofs !== plan.freeDofs || !errorBound(raw.referenceEquilibriumResidual)
    || !errorBound(raw.maximumElementInitialStressError) || !denseArray(raw.modes, input.modeCount)) {
    throw new Error('solid-buckling-result: invalid metadata, reference equilibrium or initial-stress agreement');
  }
  const fixed = plan.reference.fixed;
  let previous = 0;
  const modes: SolidBucklingMode[] = raw.modes.map((mode: unknown, index: number) => {
    if (!record(mode) || !exactFields(mode, ['number', 'loadFactor', 'normalizedResidual', 'shape'])
      || mode.number !== index + 1 || typeof mode.loadFactor !== 'number' || !Number.isFinite(mode.loadFactor)
      || !(mode.loadFactor > 0) || mode.loadFactor < previous || !errorBound(mode.normalizedResidual)
      || !denseArray(mode.shape, fixed.length)) {
      throw new Error('solid-buckling-result: invalid load factor, residual or mode ordering');
    }
    previous = mode.loadFactor;
    let amplitude = 0;
    const shape = mode.shape.map((value: unknown, node: number) => {
      if (!vector(value)) throw new Error('solid-buckling-result: non-finite mode shape');
      if (fixed[node].some((restrained, axis) => restrained && value[axis] !== 0)) {
        throw new Error('solid-buckling-result: mode violates a prescribed support');
      }
      amplitude = Math.max(amplitude, Math.hypot(...value));
      return value;
    });
    if (Math.abs(amplitude - 1) > 1e-10) throw new Error('solid-buckling-result: invalid shape normalization');
    return { number: index + 1, loadFactor: mode.loadFactor, normalizedResidual: mode.normalizedResidual, shape };
  });
  return {
    kind: 'oofem-solid-tet4-buckling', method: SOLID_BUCKLING_METHOD, scope: 'linear-elastic-prestress-bifurcation',
    units: 'N-mm-MPa', source, inputSha256, freeDofs: plan.freeDofs,
    referenceEquilibriumResidual: raw.referenceEquilibriumResidual,
    maximumElementInitialStressError: raw.maximumElementInitialStressError, modes, structuralCertification: false,
  };
}
