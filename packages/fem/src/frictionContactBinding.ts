import { sha256Hex } from './sha256.js';
import { translateBeamFrictionContact } from './frictionContactTranslation.js';
import { frictionContactResultMatches, type FrictionContactResult, type FrictionSolveOptions } from './frictionContactResults.js';

/** Computes the canonical owned input digest before any caller may mutate its original input. */
export async function frictionContactInputSha256(value: unknown): Promise<string> {
  const input = translateBeamFrictionContact(value).input;
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  return await sha256Hex(bytes);
}

/** Structural discrimination and consistency only; no independent K-based physics certification. */
export function isFrictionContactResult(value: unknown): value is FrictionContactResult {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    const fields = ['input', 'inputSha256', 'solver', 'iterationLimit'];
    const descriptors = fields.map(key => Object.getOwnPropertyDescriptor(value, key));
    if (descriptors.some(d => d === undefined || !d.enumerable || !('value' in d))) return false;
    const input: unknown = descriptors[0]?.value, hash: unknown = descriptors[1]?.value;
    const solver: unknown = descriptors[2]?.value, iterationLimit: unknown = descriptors[3]?.value;
    if (typeof hash !== 'string' || (solver !== 'newton' && solver !== 'nsgs')
      || typeof iterationLimit !== 'number') return false;
    const options: FrictionSolveOptions = { solver, iterationLimit };
    return frictionContactResultMatches(value, input, hash, options);
  } catch { return false; }
}
