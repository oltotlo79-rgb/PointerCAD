import { isRecord } from './valueGuards.js';
import { decodeSolidFinite, readSolidFiniteNative, solidFiniteResultMatches, type SolidFiniteResult } from './solidFiniteResults.js';
import { translateSolidFinite, type SolidFiniteInput } from './solidFiniteTranslation.js';

/** Transport discriminant only: the validated W33/W34 numerical result is kept intact underneath. */
export const SOLID_FINITE_KIND = 'oofem-finite-j2-equilibrium';
export interface SolidFiniteWireResult {
  readonly kind: typeof SOLID_FINITE_KIND;
  readonly result: SolidFiniteResult;
}

/** Synchronous admission checks every native record. Digest authenticity is checked asynchronously by the client. */
export function isSolidFiniteWireResult(value: unknown): value is SolidFiniteWireResult {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2 || value.kind !== SOLID_FINITE_KIND
    || !isRecord(value.result)) return false;
  const { input, inputSha256, ...native } = value.result;
  if (!Object.hasOwn(value.result, 'input') || !Object.hasOwn(value.result, 'inputSha256')
    || typeof inputSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(inputSha256)) return false;
  try {
    const prepared = translateSolidFinite(input);
    return readSolidFiniteNative(native, prepared.plan).retainedNativeAnalyses === 1;
  } catch { return false; }
}

/** Never trusts a reply's declared input hash: re-decode against the owned request and recompute its digest. */
export async function decodeSolidFiniteWireResult(value: unknown, input: SolidFiniteInput,
  hash: string): Promise<SolidFiniteWireResult> {
  if (!isSolidFiniteWireResult(value) || !solidFiniteResultMatches(value.result, input, hash)) {
    throw new Error('finite-equilibrium-result: wire result differs from the owned input');
  }
  const { input: declaredInput, inputSha256: declaredHash, ...native } = value.result;
  // Keep the declarations used and checked explicitly; no unknown wrapper fields reach the numerical decoder.
  if (declaredHash !== hash || JSON.stringify(declaredInput) !== JSON.stringify(translateSolidFinite(input).input)) {
    throw new Error('finite-equilibrium-result: wire ownership changed');
  }
  return Object.freeze({ kind: SOLID_FINITE_KIND, result: await decodeSolidFinite(native, input, hash) });
}
