import { readPlasticBarPlan, type PlasticBarPlan } from './plasticBar.js';

/** A plastic-bar request bound to the document revision it was configured in; a later revision makes it stale. */
export const PLASTIC_BAR_INPUT_SCHEMA = 'pointercad-plastic-bar/1';
export interface PlasticBarSource {
  readonly documentId: string;
  readonly revision: number;
}
export interface PlasticBarInput {
  readonly schema: typeof PLASTIC_BAR_INPUT_SCHEMA;
  readonly source: PlasticBarSource;
  readonly plan: PlasticBarPlan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`plastic-bar-input: ${path} must be an object`);
  const row = value;
  if (Object.keys(row).length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    throw new Error(`plastic-bar-input: ${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}

/** Validates and copies: the returned input owns fresh values that a caller cannot mutate afterwards. */
export function translatePlasticBar(value: unknown): { readonly input: PlasticBarInput; readonly plan: PlasticBarPlan } {
  const row = exactFields(value, ['schema', 'source', 'plan'], '$');
  if (row.schema !== PLASTIC_BAR_INPUT_SCHEMA) throw new Error('plastic-bar-input: unsupported input schema');
  const source = exactFields(row.source, ['documentId', 'revision'], 'source');
  if (typeof source.documentId !== 'string' || source.documentId.length === 0 || source.documentId.length > 256) {
    throw new Error('plastic-bar-input: source.documentId must have 1 to 256 characters');
  }
  if (typeof source.revision !== 'number' || !Number.isSafeInteger(source.revision) || source.revision < 0) {
    throw new Error('plastic-bar-input: source.revision must be a non-negative integer');
  }
  const plan = readPlasticBarPlan(row.plan);
  return { input: { schema: PLASTIC_BAR_INPUT_SCHEMA,
    source: { documentId: source.documentId, revision: source.revision }, plan }, plan };
}

export async function plasticBarInputSha256(value: unknown): Promise<string> {
  const input = translatePlasticBar(value).input;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
