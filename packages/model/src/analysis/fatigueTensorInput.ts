import { InputIssue, text } from './analysisValidation.js';
import { FATIGUE_SAVED_ID, FATIGUE_SAVED_LIMITS, denseFatigueList, exactFatigueFields, fatigueLabel, finiteFatigueNumber,
  readFatigueSavedCurve, readFatigueSavedSource, type FatigueSavedCurve, type FatigueSavedSource } from './fatigueInput.js';

/**
 * Saved proportional-tensor fatigue input: version 4 of the saved fatigue configuration, stored under its own analysis
 * kind 'fatigue-proportional-tensor' with the single fatigue id, so one document holds either this or a stress-history
 * configuration (versions 1 to 3 are unchanged and still read by readFatigueSavedInput). The input is exactly the
 * `pointercad-fatigue-proportional-tensor/1` input of @pointercad/fem fatigueTensor.ts: per history one reference Cauchy
 * stress tensor (MPa, tensor shear components in the order xx, yy, zz, yz, xz, xy) and chronological signed load
 * factors, with the user's curve, sequence, repeats and sources. Only inputs are stored: the converted equivalent
 * stresses, cycles, damage and life never are. There is no Goodman correction for this input (an extra field is refused).
 * The model cannot import the solver package, so the core's acceptance rules are mirrored with the same operations in
 * the same order; the UI package compares both readers' verdicts on an explicit boundary table.
 */
export const FATIGUE_SAVED_TENSOR_SCHEMA = 'pointercad-fatigue-saved/4';
export const FATIGUE_SAVED_TENSOR_INPUT_SCHEMA = 'pointercad-fatigue-proportional-tensor/1';
export const FATIGUE_SAVED_TENSOR_METHOD = 'proportional-elastic-signed-von-mises-absolute-largest-principal/1';
export const FATIGUE_SAVED_TENSOR_COMPONENTS = 'cauchy-tensor-shear-xx-yy-zz-yz-xz-xy';
/** HYDROSTATIC_TOLERANCE of the core: a deviatoric part this small relative to the largest component is hydrostatic. */
const HYDROSTATIC_TOLERANCE = 1e-12;

export interface FatigueSavedTensorReference {
  readonly unit: 'MPa';
  readonly components: typeof FATIGUE_SAVED_TENSOR_COMPONENTS;
  readonly xx: number; readonly yy: number; readonly zz: number;
  readonly yz: number; readonly xz: number; readonly xy: number;
}
export interface FatigueSavedTensorHistory {
  readonly id: string;
  readonly reference: FatigueSavedTensorReference;
  readonly loadFactors: readonly number[];
  readonly sequence: 'once' | 'repeated-periodic';
  readonly repeats: number;
  readonly source: FatigueSavedSource;
}
/** Structurally the proportional-tensor input of @pointercad/fem (the model cannot import the solver package). */
export interface FatigueSavedTensorProblem {
  readonly schema: typeof FATIGUE_SAVED_TENSOR_INPUT_SCHEMA;
  readonly method: typeof FATIGUE_SAVED_TENSOR_METHOD;
  readonly curve: FatigueSavedCurve;
  readonly histories: readonly FatigueSavedTensorHistory[];
}
export interface FatigueTensorSavedInput {
  readonly schema: typeof FATIGUE_SAVED_TENSOR_SCHEMA;
  readonly id: typeof FATIGUE_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueSavedTensorProblem;
}

function fail(path: string, message: string): never {
  throw new InputIssue('fatigue', path, message);
}

function readComponent(row: Record<string, unknown>, key: 'xx' | 'yy' | 'zz' | 'yz' | 'xz' | 'xy', path: string): number {
  const value = finiteFatigueNumber(row[key], `${path}.${key}`);
  if (Math.abs(value) > FATIGUE_SAVED_LIMITS.maximumStressMpa) fail(`${path}.${key}`, 'Expected |component| of at most 1e4 MPa');
  return value === 0 ? 0 : value;
}

function readReference(value: unknown, path: string): FatigueSavedTensorReference {
  const row = exactFatigueFields(value, ['unit', 'components', 'xx', 'yy', 'zz', 'yz', 'xz', 'xy'], path);
  if (row.unit !== 'MPa') fail(`${path}.unit`, 'Expected MPa');
  if (row.components !== FATIGUE_SAVED_TENSOR_COMPONENTS) fail(`${path}.components`, 'Expected tensor shear components xx, yy, zz, yz, xz, xy');
  return { unit: 'MPa', components: FATIGUE_SAVED_TENSOR_COMPONENTS, xx: readComponent(row, 'xx', path),
    yy: readComponent(row, 'yy', path), zz: readComponent(row, 'zz', path), yz: readComponent(row, 'yz', path),
    xz: readComponent(row, 'xz', path), xy: readComponent(row, 'xy', path) };
}

/** The core's von Mises equivalent of the reference (MPa): the same scaling by the largest |component|, hydrostatic test
 * and operation order as convert() of fatigueTensor.ts, refused where the core refuses. */
function equivalentMpa(reference: FatigueSavedTensorReference, path: string): number {
  const scale = Math.max(Math.abs(reference.xx), Math.abs(reference.yy), Math.abs(reference.zz), Math.abs(reference.yz),
    Math.abs(reference.xz), Math.abs(reference.xy));
  if (scale === 0) fail(path, 'A zero reference tensor defines no load');
  const xx = reference.xx / scale, yy = reference.yy / scale, zz = reference.zz / scale;
  const yz = reference.yz / scale, xz = reference.xz / scale, xy = reference.xy / scale;
  const q = (xx + yy + zz) / 3;
  const dx = xx - q, dy = yy - q, dz = zz - q;
  const p2 = dx * dx + dy * dy + dz * dz + 2 * (yz * yz + xz * xz + xy * xy);
  if (!(Math.sqrt(p2 / 6) > HYDROSTATIC_TOLERANCE)) fail(path, 'A hydrostatic reference tensor has no von Mises equivalent');
  const vonMises = scale * Math.sqrt(((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * (yz * yz + xz * xz + xy * xy));
  if (!(vonMises > 0)) fail(path, 'The equivalent stress of a nonzero reference rounds to zero');
  return vonMises;
}

function readHistory(value: unknown, path: string): FatigueSavedTensorHistory {
  const row = exactFatigueFields(value, ['id', 'reference', 'loadFactors', 'sequence', 'repeats', 'source'], path);
  const id = fatigueLabel(row.id, `${path}.id`, 64);
  const reference = readReference(row.reference, `${path}.reference`);
  const items = denseFatigueList(row.loadFactors, `${path}.loadFactors`);
  if (items.length < 1 || items.length > FATIGUE_SAVED_LIMITS.maximumPoints) fail(`${path}.loadFactors`, 'Expected 1 to 100000 load factors');
  const loadFactors = items.map((item, index) => finiteFatigueNumber(item, `${path}.loadFactors[${index}]`));
  const equivalent = equivalentMpa(reference, `${path}.reference`);
  for (const [index, factor] of loadFactors.entries()) {
    // |factor x (+-equivalent)| = |factor x equivalent| exactly, so the core's sign does not change either refusal.
    const stress = factor * equivalent;
    if (factor !== 0 && stress === 0) fail(`${path}.loadFactors[${index}]`, 'A nonzero factor gives a stress that rounds to zero');
    if (!(Math.abs(stress) <= FATIGUE_SAVED_LIMITS.maximumStressMpa)) {
      fail(`${path}.loadFactors[${index}]`, 'Expected |factor x equivalent stress| of at most 1e4 MPa');
    }
  }
  const sequence = row.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') fail(`${path}.sequence`, 'Expected once or repeated-periodic');
  const repeats = row.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > FATIGUE_SAVED_LIMITS.maximumRepeats
    || (sequence === 'once' && repeats !== 1)) fail(`${path}.repeats`, 'Expected 1 for once, or 1 to 1e9 repeats');
  return { id, reference, loadFactors, sequence, repeats, source: readFatigueSavedSource(row.source, `${path}.source`) };
}

/** Strict reader of the saved proportional-tensor problem: the same fields, bounds and refusals as the core. */
export function readFatigueTensorSavedProblem(value: unknown, path: string): FatigueSavedTensorProblem {
  const row = exactFatigueFields(value, ['schema', 'method', 'curve', 'histories'], path);
  if (row.schema !== FATIGUE_SAVED_TENSOR_INPUT_SCHEMA) fail(`${path}.schema`, 'Expected proportional tensor input schema 1');
  if (row.method !== FATIGUE_SAVED_TENSOR_METHOD) fail(`${path}.method`, 'Expected the proportional signed von Mises method');
  const curve = readFatigueSavedCurve(row.curve, `${path}.curve`);
  const rows = denseFatigueList(row.histories, `${path}.histories`);
  if (rows.length < 1 || rows.length > FATIGUE_SAVED_LIMITS.maximumHistories) fail(`${path}.histories`, 'Expected 1 to 64 histories');
  const ids = new Set<string>();
  const histories = rows.map((item, index) => {
    const history = readHistory(item, `${path}.histories[${index}]`);
    if (ids.has(history.id)) fail(`${path}.histories[${index}].id`, 'Duplicate history id');
    ids.add(history.id);
    return history;
  });
  return { schema: FATIGUE_SAVED_TENSOR_INPUT_SCHEMA, method: FATIGUE_SAVED_TENSOR_METHOD, curve, histories };
}

/** Strict reader of a saved proportional-tensor configuration. Any other version is refused; nothing is coerced. */
export function readFatigueTensorSavedInput(value: unknown, path: string): FatigueTensorSavedInput {
  const schema = value !== null && typeof value === 'object' && 'schema' in value ? value.schema : undefined;
  if (schema !== FATIGUE_SAVED_TENSOR_SCHEMA) {
    throw new InputIssue('unsupported-model', path, 'Expected saved fatigue schema 4 for a proportional tensor input');
  }
  const row = exactFatigueFields(value, ['schema', 'id', 'source', 'input'], path);
  if (row.id !== FATIGUE_SAVED_ID) fail(`${path}.id`, 'Unexpected fatigue input id');
  const source = exactFatigueFields(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  return { schema: FATIGUE_SAVED_TENSOR_SCHEMA, id: FATIGUE_SAVED_ID, source: { documentId },
    input: readFatigueTensorSavedProblem(row.input, `${path}.input`) };
}
