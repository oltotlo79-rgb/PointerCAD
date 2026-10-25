import { readSolidPlasticPlan, type SolidPlasticPlan } from './solidPlastic.js';

/**
 * PROVISIONAL (unexecuted; native support unproven until Root runs proof-r2). Same request binding as
 * plasticBarTranslation.ts: a solid-plastic request is bound to the document revision it was configured in, and a
 * later revision makes it stale. No dispatch, protocol kind or runtime entry exists for it yet.
 */
export const SOLID_PLASTIC_INPUT_SCHEMA = 'pointercad-solid-plastic/1';
export interface SolidPlasticSource {
  readonly documentId: string;
  readonly revision: number;
}
export interface SolidPlasticInput {
  readonly schema: typeof SOLID_PLASTIC_INPUT_SCHEMA;
  readonly source: SolidPlasticSource;
  readonly plan: SolidPlasticPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`solid-plastic-input: ${path} must be an object`);
  const row = value;
  if (Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    throw new Error(`solid-plastic-input: ${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}

/** Validates and copies: the returned input owns fresh values that a caller cannot mutate afterwards. */
export function translateSolidPlastic(value: unknown): { readonly input: SolidPlasticInput; readonly plan: SolidPlasticPlan } {
  const row = exactFields(value, ['schema', 'source', 'plan'], '$');
  if (row.schema !== SOLID_PLASTIC_INPUT_SCHEMA) throw new Error('solid-plastic-input: unsupported input schema');
  const source = exactFields(row.source, ['documentId', 'revision'], 'source');
  if (typeof source.documentId !== 'string' || source.documentId.length === 0 || source.documentId.length > 256) {
    throw new Error('solid-plastic-input: source.documentId must have 1 to 256 characters');
  }
  if (typeof source.revision !== 'number' || !Number.isSafeInteger(source.revision) || source.revision < 0) {
    throw new Error('solid-plastic-input: source.revision must be a non-negative integer');
  }
  const plan = readSolidPlasticPlan(row.plan);
  return { input: { schema: SOLID_PLASTIC_INPUT_SCHEMA,
    source: { documentId: source.documentId, revision: source.revision }, plan }, plan };
}

export async function solidPlasticInputSha256(value: unknown): Promise<string> {
  const input = translateSolidPlastic(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
