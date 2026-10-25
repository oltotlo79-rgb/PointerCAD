import { translateSolidPlastic, type SolidPlasticInput } from './solidPlasticTranslation.js';
import { readSolidPlasticNative, SOLID_PLASTIC_METHOD, SOLID_PLASTIC_RESULT_SCHEMA, SOLID_PLASTIC_SCOPE,
  type SolidPlasticNative } from './solidPlasticResults.js';

/** Request-bound result, not a certification or an independent constitutive oracle. */
export interface SolidPlasticResult extends SolidPlasticNative {
  readonly kind: 'oofem-plastic-solid-tet4';
  readonly input: SolidPlasticInput;
  readonly inputSha256: string;
  readonly method: typeof SOLID_PLASTIC_METHOD;
  readonly scope: typeof SOLID_PLASTIC_SCOPE;
  readonly structuralCertification: false;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function decodeSolidPlastic(raw: unknown, value: SolidPlasticInput, hash: string): SolidPlasticResult {
  if (!digest(hash)) throw new Error('Invalid solid-plastic input digest');
  const input = translateSolidPlastic(value).input;
  const native = readSolidPlasticNative(raw, input.plan);
  return { kind: 'oofem-plastic-solid-tet4', input, inputSha256: hash,
    method: SOLID_PLASTIC_METHOD, scope: SOLID_PLASTIC_SCOPE, structuralCertification: false, ...native };
}

export function isSolidPlasticResult(value: unknown): value is SolidPlasticResult {
  if (!record(value)) return false;
  const row = value;
  const keys = ['kind', 'input', 'inputSha256', 'method', 'scope', 'structuralCertification', 'records', 'yielded'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
    || row.kind !== 'oofem-plastic-solid-tet4' || !digest(row.inputSha256)) return false;
  try {
    const input = translateSolidPlastic(row.input).input;
    readSolidPlasticNative({ schema: SOLID_PLASTIC_RESULT_SCHEMA, method: row.method, scope: row.scope,
      structuralCertification: row.structuralCertification, records: row.records, yielded: row.yielded }, input.plan);
    return true;
  } catch { return false; }
}

export function solidPlasticResultMatches(value: unknown, input: SolidPlasticInput, hash: string): value is SolidPlasticResult {
  return isSolidPlasticResult(value) && value.inputSha256 === hash
    && JSON.stringify(translateSolidPlastic(value.input).input) === JSON.stringify(translateSolidPlastic(input).input);
}
