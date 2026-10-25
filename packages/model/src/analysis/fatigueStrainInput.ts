import { fields, InputIssue, text } from './analysisValidation.js';
import type { FatigueSavedSource } from './fatigueInput.js';

/**
 * Saved strain-life fatigue inputs (at most one per document), a separate kind from the stress-life `fatigue` input
 * whose saved versions 1/2/3 are unchanged. The problem is structurally the `pointercad-strain-history/1` input of
 * @pointercad/fem fatigueStrainHistory.ts (the model cannot import the solver package): user-supplied Basquin /
 * Coffin-Manson coefficients with their calibrated life interval and source, local TOTAL strain histories (measured or
 * from an elastic-plastic analysis, never a stress divided by E) and the explicit zero-mean-stress assumption. Only
 * inputs are stored; cycles, damage and life are never stored, and nothing is derived from a material name.
 */
export const FATIGUE_STRAIN_SAVED_SCHEMA = 'pointercad-fatigue-strain-saved/1';
/** The single saved strain-life configuration of a document; distinct from the stress-life id 'fatigue'. */
export const FATIGUE_STRAIN_SAVED_ID = 'fatigue-strain-life';
/** The saved strain-life configuration whose every history sample pairs the local strain with the local stress at the
 * same time (Morrow with the paired reversal stresses). Its own saved schema under the same id, so a document holds one
 * strain-life configuration; a reader that knows only schema 1 refuses it as an unsupported version and never reads it
 * as the zero-mean problem. */
export const FATIGUE_STRAIN_STRESS_SAVED_SCHEMA = 'pointercad-fatigue-strain-stress-saved/1';

export interface FatigueStrainSavedMaterial {
  readonly id: string;
  readonly stressUnit: 'MPa';
  readonly elasticModulusMpa: number;
  readonly fatigueStrengthCoefficientMpa: number;
  readonly fatigueStrengthExponent: number;
  readonly fatigueDuctilityCoefficient: number;
  readonly fatigueDuctilityExponent: number;
  /** Inclusive life interval in cycles over which the user's coefficients are valid. */
  readonly calibration: { readonly minimumCycles: number; readonly maximumCycles: number };
  readonly source: FatigueSavedSource;
}
export interface FatigueStrainSavedHistory {
  readonly id: string;
  readonly strainMeasure: 'local-total-strain';
  readonly strainUnit: 'dimensionless';
  readonly derivation: 'measured' | 'elastic-plastic-analysis';
  readonly strain: readonly number[];
  readonly sequence: 'once' | 'repeated-periodic';
  readonly repeats: number;
  readonly source: FatigueSavedSource;
}
/** Structurally the StrainHistoryInput of @pointercad/fem. */
export interface FatigueStrainSavedProblem {
  readonly schema: 'pointercad-strain-history/1';
  readonly meanStress: 'assumed-zero';
  readonly material: FatigueStrainSavedMaterial;
  readonly histories: readonly FatigueStrainSavedHistory[];
}
/** One paired sample: the local total strain and the local stress at the same time (tension positive). */
export interface FatigueStrainStressSavedSample {
  readonly timeSeconds: number;
  readonly strain: number;
  readonly stressMpa: number;
}
/** A history whose every sample carries both channels; nothing pairs two separate lists by position. */
export interface FatigueStrainStressSavedHistory {
  readonly id: string;
  readonly strainMeasure: 'local-total-strain';
  readonly strainUnit: 'dimensionless';
  readonly stressMeasure: 'local-stress';
  readonly stressUnit: 'MPa';
  readonly timeUnit: 'second';
  readonly derivation: 'measured' | 'elastic-plastic-analysis';
  readonly samples: readonly FatigueStrainStressSavedSample[];
  readonly sequence: 'once' | 'repeated-periodic';
  readonly repeats: number;
  readonly source: FatigueSavedSource;
}
/**
 * Structurally the StrainStressHistoryInput of @pointercad/fem fatigueStrainStressHistory.ts: the mean stress of every
 * rainflow cycle is taken from the paired stresses at its strain reversals and applied with the existing Morrow
 * correction. A distinct schema, never read as the zero-mean strain-only problem (and vice versa).
 */
export interface FatigueStrainStressSavedProblem {
  readonly schema: 'pointercad-strain-stress-history/1';
  readonly meanStress: 'morrow-paired-reversal-stress';
  readonly material: FatigueStrainSavedMaterial;
  readonly histories: readonly FatigueStrainStressSavedHistory[];
}
export interface FatigueStrainSavedInput {
  readonly schema: typeof FATIGUE_STRAIN_SAVED_SCHEMA;
  readonly id: typeof FATIGUE_STRAIN_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueStrainSavedProblem;
}

export interface FatigueStrainStressSavedInput {
  readonly schema: typeof FATIGUE_STRAIN_STRESS_SAVED_SCHEMA;
  readonly id: typeof FATIGUE_STRAIN_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueStrainStressSavedProblem;
}
/** The one strain-life configuration of a document: zero-mean strain only, or strain paired with stress. */
export type FatigueStrainSavedConfiguration = FatigueStrainSavedInput | FatigueStrainStressSavedInput;

/** Same bounds and the same check order as fatigueStrainLife.ts / fatigueStrainHistory.ts of @pointercad/fem;
 * fatigueStrainPersistence.test.ts in the fem package compares the verdicts and paths of both readers on the same
 * cases, so a drift of either copy is reported. */
const LIMITS = {
  elasticModulusMpa: [1e3, 1e7], fatigueStrengthCoefficientMpa: [1, 1e4], fatigueDuctilityCoefficient: [1e-6, 10],
  exponent: [-2, -1e-3], cycles: [0.5, 1e12], maximumAbsStrain: 1, maximumPoints: 100_000, maximumHistories: 64,
  maximumRepeats: 1e9, maximumAbsStressMpa: 1e4,
} as const;

function fail(path: string, message: string): never {
  throw new InputIssue('fatigue-strain', path, message);
}
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  // fields() checks the count and presence; own keys only (an inherited name is not a saved field).
  const row = fields(value, keys, path);
  if (!keys.every(key => Object.hasOwn(row, key))) fail(path, 'Unsupported or missing field');
  return row;
}
function dense(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'Expected a list');
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail(path, 'Expected a list without holes');
  }
  return value;
}
function label(value: unknown, path: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    fail(path, `Expected nonempty text of at most ${maximum} characters`);
  }
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'Expected a finite number');
  return value;
}
/** Finite, of the required sign (a zero of either sign is refused), then within limits: the solver's order. */
function signed(value: unknown, path: string, sign: 1 | -1, [minimum, maximum]: readonly [number, number]): number {
  const number = finite(value, path);
  if (Math.sign(number) !== sign) fail(path, sign > 0 ? 'Expected a positive value' : 'Expected a negative value');
  if (number < minimum || number > maximum) fail(path, `Expected a value from ${minimum} to ${maximum}`);
  return number;
}
function readSource(value: unknown, path: string): FatigueSavedSource {
  const row = exact(value, ['kind', 'reference', 'condition'], path);
  if (row.kind !== 'user-supplied') fail(path, 'Fatigue data must be user-supplied');
  return { kind: 'user-supplied', reference: label(row.reference, path, 512), condition: label(row.condition, path, 512) };
}

function readMaterial(value: unknown, path: string): FatigueStrainSavedMaterial {
  const row = exact(value, ['id', 'stressUnit', 'elasticModulusMpa', 'fatigueStrengthCoefficientMpa',
    'fatigueStrengthExponent', 'fatigueDuctilityCoefficient', 'fatigueDuctilityExponent', 'calibration', 'source'], path);
  const id = label(row.id, `${path}.id`, 64);
  if (row.stressUnit !== 'MPa') fail(`${path}.stressUnit`, 'Expected MPa');
  const elasticModulusMpa = signed(row.elasticModulusMpa, `${path}.elasticModulusMpa`, 1, LIMITS.elasticModulusMpa);
  const fatigueStrengthCoefficientMpa = signed(row.fatigueStrengthCoefficientMpa, `${path}.fatigueStrengthCoefficientMpa`, 1,
    LIMITS.fatigueStrengthCoefficientMpa);
  const fatigueStrengthExponent = signed(row.fatigueStrengthExponent, `${path}.fatigueStrengthExponent`, -1, LIMITS.exponent);
  const fatigueDuctilityCoefficient = signed(row.fatigueDuctilityCoefficient, `${path}.fatigueDuctilityCoefficient`, 1,
    LIMITS.fatigueDuctilityCoefficient);
  const fatigueDuctilityExponent = signed(row.fatigueDuctilityExponent, `${path}.fatigueDuctilityExponent`, -1, LIMITS.exponent);
  const calibration = exact(row.calibration, ['minimumCycles', 'maximumCycles'], `${path}.calibration`);
  const minimumCycles = signed(calibration.minimumCycles, `${path}.calibration.minimumCycles`, 1, LIMITS.cycles);
  const maximumCycles = signed(calibration.maximumCycles, `${path}.calibration.maximumCycles`, 1, LIMITS.cycles);
  if (!(minimumCycles < maximumCycles)) fail(`${path}.calibration.maximumCycles`, 'Expected minimum cycles below maximum cycles');
  return { id, stressUnit: 'MPa', elasticModulusMpa, fatigueStrengthCoefficientMpa, fatigueStrengthExponent,
    fatigueDuctilityCoefficient, fatigueDuctilityExponent, calibration: { minimumCycles, maximumCycles },
    source: readSource(row.source, `${path}.source`) };
}

function readHistory(value: unknown, path: string): FatigueStrainSavedHistory {
  const row = exact(value, ['id', 'strainMeasure', 'strainUnit', 'derivation', 'strain', 'sequence', 'repeats', 'source'], path);
  const id = label(row.id, `${path}.id`, 64);
  if (row.strainMeasure !== 'local-total-strain') fail(`${path}.strainMeasure`, 'Expected a local total strain');
  const derivation = row.derivation;
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') {
    fail(`${path}.derivation`, 'Expected a measured or elastic-plastic local strain');
  }
  if (row.strainUnit !== 'dimensionless') fail(`${path}.strainUnit`, 'Expected a dimensionless strain');
  const points = dense(row.strain, `${path}.strain`);
  if (points.length < 1 || points.length > LIMITS.maximumPoints) fail(`${path}.strain`, 'Expected 1 to 100000 strains');
  const strain: number[] = [];
  for (const [index, point] of points.entries()) {
    const value = finite(point, `${path}.strain[${index}]`);
    if (Math.abs(value) > LIMITS.maximumAbsStrain) fail(`${path}.strain[${index}]`, 'Expected |strain| of at most 1');
    strain.push(value);
  }
  const sequence = row.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') fail(`${path}.sequence`, 'Expected once or repeated-periodic');
  const repeats = row.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > LIMITS.maximumRepeats
    || (sequence === 'once' && repeats !== 1)) fail(`${path}.repeats`, 'Expected 1 for once, or 1 to 1e9 repeats');
  return { id, strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation, strain, sequence, repeats,
    source: readSource(row.source, `${path}.source`) };
}

/** Strict reader of the saved problem: the same field sets, bounds, check order and refusals as the solver readers. */
export function readFatigueStrainSavedProblem(value: unknown, path: string): FatigueStrainSavedProblem {
  const row = exact(value, ['schema', 'meanStress', 'material', 'histories'], path);
  if (row.schema !== 'pointercad-strain-history/1') fail(`${path}.schema`, 'Expected strain history input schema 1');
  if (row.meanStress !== 'assumed-zero') fail(`${path}.meanStress`, 'Expected the explicit zero mean-stress assumption');
  const material = readMaterial(row.material, `${path}.material`);
  const rows = dense(row.histories, `${path}.histories`);
  if (rows.length < 1 || rows.length > LIMITS.maximumHistories) fail(`${path}.histories`, 'Expected 1 to 64 histories');
  const ids = new Set<string>();
  const histories = rows.map((item, index) => {
    const history = readHistory(item, `${path}.histories[${index}]`);
    if (ids.has(history.id)) fail(`${path}.histories[${index}].id`, 'Duplicate history id');
    ids.add(history.id);
    return history;
  });
  return { schema: 'pointercad-strain-history/1', meanStress: 'assumed-zero', material, histories };
}

function readStrainStressSample(value: unknown, path: string, previousTime: number | null): FatigueStrainStressSavedSample {
  const row = exact(value, ['timeSeconds', 'strain', 'stressMpa'], path);
  const timeSeconds = finite(row.timeSeconds, `${path}.timeSeconds`);
  const strain = finite(row.strain, `${path}.strain`);
  const stressMpa = finite(row.stressMpa, `${path}.stressMpa`);
  if (Math.abs(strain) > LIMITS.maximumAbsStrain) fail(`${path}.strain`, 'Expected |strain| of at most 1');
  if (Math.abs(stressMpa) > LIMITS.maximumAbsStressMpa) fail(`${path}.stressMpa`, 'Expected |stress| of at most 10000 MPa');
  // Strictly increasing time: a repeated or earlier time is a duplicated or reordered sample, never merged or sorted.
  if (previousTime !== null && !(timeSeconds > previousTime)) fail(`${path}.timeSeconds`, 'Expected a time later than the previous sample');
  return { timeSeconds, strain, stressMpa };
}

function readStrainStressHistory(value: unknown, path: string): FatigueStrainStressSavedHistory {
  const row = exact(value, ['id', 'strainMeasure', 'strainUnit', 'stressMeasure', 'stressUnit', 'timeUnit', 'derivation',
    'samples', 'sequence', 'repeats', 'source'], path);
  const id = label(row.id, `${path}.id`, 64);
  if (row.strainMeasure !== 'local-total-strain') fail(`${path}.strainMeasure`, 'Expected a local total strain');
  if (row.stressMeasure !== 'local-stress') fail(`${path}.stressMeasure`, 'Expected a local stress');
  const derivation = row.derivation;
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') {
    fail(`${path}.derivation`, 'Expected measured or elastic-plastic local strain and stress');
  }
  if (row.strainUnit !== 'dimensionless') fail(`${path}.strainUnit`, 'Expected a dimensionless strain');
  if (row.stressUnit !== 'MPa') fail(`${path}.stressUnit`, 'Expected MPa');
  if (row.timeUnit !== 'second') fail(`${path}.timeUnit`, 'Expected seconds');
  const rows = dense(row.samples, `${path}.samples`);
  if (rows.length < 1 || rows.length > LIMITS.maximumPoints) fail(`${path}.samples`, 'Expected 1 to 100000 samples');
  const samples: FatigueStrainStressSavedSample[] = [];
  for (const [index, item] of rows.entries()) {
    samples.push(readStrainStressSample(item, `${path}.samples[${index}]`, samples.at(-1)?.timeSeconds ?? null));
  }
  const sequence = row.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') fail(`${path}.sequence`, 'Expected once or repeated-periodic');
  const repeats = row.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > LIMITS.maximumRepeats
    || (sequence === 'once' && repeats !== 1)) fail(`${path}.repeats`, 'Expected 1 for once, or 1 to 1e9 repeats');
  return { id, strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress', stressUnit: 'MPa',
    timeUnit: 'second', derivation, samples, sequence, repeats, source: readSource(row.source, `${path}.source`) };
}

/** Strict reader of the saved paired problem: the same field sets, bounds, check order and refusal paths as the solver
 * reader validateStrainStressHistoryInput of @pointercad/fem (compared case by case in fatigueStrainStressPersistence.test.ts). */
export function readFatigueStrainStressSavedProblem(value: unknown, path: string): FatigueStrainStressSavedProblem {
  const row = exact(value, ['schema', 'meanStress', 'material', 'histories'], path);
  if (row.schema !== 'pointercad-strain-stress-history/1') fail(`${path}.schema`, 'Expected paired strain-stress history schema 1');
  if (row.meanStress !== 'morrow-paired-reversal-stress') fail(`${path}.meanStress`, 'Expected the paired reversal-stress Morrow correction');
  const material = readMaterial(row.material, `${path}.material`);
  const rows = dense(row.histories, `${path}.histories`);
  if (rows.length < 1 || rows.length > LIMITS.maximumHistories) fail(`${path}.histories`, 'Expected 1 to 64 histories');
  const ids = new Set<string>();
  const histories = rows.map((item, index) => {
    const history = readStrainStressHistory(item, `${path}.histories[${index}]`);
    if (ids.has(history.id)) fail(`${path}.histories[${index}].id`, 'Duplicate history id');
    ids.add(history.id);
    return history;
  });
  return { schema: 'pointercad-strain-stress-history/1', meanStress: 'morrow-paired-reversal-stress', material, histories };
}

/** Strict reader of the saved configuration. Unknown versions and invalid values are rejected; nothing is coerced. */
export function readFatigueStrainSavedInput(value: unknown, path: string): FatigueStrainSavedInput {
  const row = exact(value, ['schema', 'id', 'source', 'input'], path);
  if (row.schema !== FATIGUE_STRAIN_SAVED_SCHEMA) {
    throw new InputIssue('unsupported-model', path, 'Expected saved strain-life fatigue schema 1');
  }
  if (row.id !== FATIGUE_STRAIN_SAVED_ID) fail(`${path}.id`, 'Unexpected strain-life fatigue input id');
  const source = exact(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  return { schema: FATIGUE_STRAIN_SAVED_SCHEMA, id: FATIGUE_STRAIN_SAVED_ID, source: { documentId },
    input: readFatigueStrainSavedProblem(row.input, `${path}.input`) };
}

/** Strict reader of the saved paired configuration: the paired problem under its own saved schema. */
export function readFatigueStrainStressSavedInput(value: unknown, path: string): FatigueStrainStressSavedInput {
  const row = exact(value, ['schema', 'id', 'source', 'input'], path);
  if (row.schema !== FATIGUE_STRAIN_STRESS_SAVED_SCHEMA) {
    throw new InputIssue('unsupported-model', path, 'Expected saved paired strain-stress fatigue schema 1');
  }
  if (row.id !== FATIGUE_STRAIN_SAVED_ID) fail(`${path}.id`, 'Unexpected strain-life fatigue input id');
  const source = exact(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  return { schema: FATIGUE_STRAIN_STRESS_SAVED_SCHEMA, id: FATIGUE_STRAIN_SAVED_ID, source: { documentId },
    input: readFatigueStrainStressSavedProblem(row.input, `${path}.input`) };
}

/** The saved configuration by its own saved schema: the paired reader only for the exact paired schema (an own data
 * property), every other value through the zero-mean reader, which refuses any version but its own. Neither variant
 * is ever read as the other, and a new or unknown version is refused, never read as the zero-mean problem. */
export function readFatigueStrainSavedConfiguration(value: unknown, path: string): FatigueStrainSavedConfiguration {
  const paired = typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getOwnPropertyDescriptor(value, 'schema')?.value === FATIGUE_STRAIN_STRESS_SAVED_SCHEMA;
  return paired ? readFatigueStrainStressSavedInput(value, path) : readFatigueStrainSavedInput(value, path);
}

/** Writer for an edit of the paired configuration, validated by the same reader (throws InputIssue). */
export function createFatigueStrainStressSavedInput(documentId: string, problem: unknown): FatigueStrainStressSavedInput {
  return readFatigueStrainStressSavedInput({ schema: FATIGUE_STRAIN_STRESS_SAVED_SCHEMA, id: FATIGUE_STRAIN_SAVED_ID,
    source: { documentId }, input: problem }, 'definition');
}

/** Writer for an edit: the saved configuration of `documentId` for an unknown problem, validated by the same reader
 * (throws InputIssue), so whatever is written is exactly what a later read returns. */
export function createFatigueStrainSavedInput(documentId: string, problem: unknown): FatigueStrainSavedInput {
  return readFatigueStrainSavedInput({ schema: FATIGUE_STRAIN_SAVED_SCHEMA, id: FATIGUE_STRAIN_SAVED_ID,
    source: { documentId }, input: problem }, 'definition');
}
