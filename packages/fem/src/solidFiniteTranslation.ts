import { isRecord } from './protocol.js';
import { sha256Hex } from './sha256.js';
import { readSolidFinitePlan, type SolidFinitePlan } from './solidFinitePlan.js';

/**
 * Input envelope of the internal finite-strain J2 equilibrium (EX-09 W34): the same document binding as
 * solidPlasticTranslation.ts (a request belongs to the document revision it was configured in; a later revision makes it
 * stale) around a validated, deep-frozen copy of the plan that solidFiniteEquilibrium.read_plan accepts. Its schema is
 * distinct from the small-strain 'pointercad-solid-plastic/1'. No protocol kind, dispatch, export or UI exists for it yet.
 */
export const SOLID_FINITE_INPUT_SCHEMA = 'pointercad-finite-j2-equilibrium-input/1';
export interface SolidFiniteSource {
  readonly documentId: string;
  readonly revision: number;
}
export interface SolidFiniteInput {
  readonly schema: typeof SOLID_FINITE_INPUT_SCHEMA;
  readonly source: SolidFiniteSource;
  readonly plan: SolidFinitePlan;
}

function exactFields(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`finite-equilibrium-input: ${path} must be an object`);
  const row = value;
  const keys = Reflect.ownKeys(row);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    throw new Error(`finite-equilibrium-input: ${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}

/** Validates and copies: the returned input is frozen and owns fresh values that a caller cannot mutate afterwards. */
export function translateSolidFinite(value: unknown): { readonly input: SolidFiniteInput; readonly plan: SolidFinitePlan } {
  const row = exactFields(value, ['schema', 'source', 'plan'], '$');
  if (row.schema !== SOLID_FINITE_INPUT_SCHEMA) throw new Error('finite-equilibrium-input: unsupported input schema');
  const source = exactFields(row.source, ['documentId', 'revision'], 'source');
  const { documentId, revision } = source;
  if (typeof documentId !== 'string' || documentId.length === 0 || documentId.length > 256) {
    throw new Error('finite-equilibrium-input: source.documentId must have 1 to 256 characters');
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('finite-equilibrium-input: source.revision must be a non-negative integer');
  }
  const plan = readSolidFinitePlan(row.plan);
  const input: SolidFiniteInput = Object.freeze({ schema: SOLID_FINITE_INPUT_SCHEMA,
    source: Object.freeze({ documentId, revision: revision === 0 ? 0 : revision }), plan });
  return Object.freeze({ input, plan });
}

/** SHA-256 of the canonical JSON of the validated copy (fixed field order, so the caller's key order does not matter). */
export async function solidFiniteInputSha256(value: unknown): Promise<string> {
  const input = translateSolidFinite(value).input;
  return sha256Hex(new TextEncoder().encode(JSON.stringify(input)));
}
