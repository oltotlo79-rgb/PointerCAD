import { fields, InputIssue, text } from './analysisValidation.js';
import type { FatigueSavedSource } from './fatigueInput.js';
import type { FatigueStrainSavedMaterial } from './fatigueStrainInput.js';

/**
 * Saved mean-stress corrected strain-life input for ONE constant-amplitude local cycle (at most one per document), a
 * separate kind from the stress-life `fatigue` input (versions 1/2/3) and from the zero-mean `fatigue-strain-life`
 * histories, both unchanged. The problem is structurally the `pointercad-strain-life-local-cycle/1` input of
 * @pointercad/fem fatigueLocalCycle.ts (the model cannot import the solver package): the user's calibrated
 * Basquin/Coffin-Manson coefficients with their source, the explicit local strain and stress extrema of one stabilized
 * cycle (measured or from an elastic-plastic analysis, with provenance) and the correction method (Morrow or SWT).
 * Only inputs are stored; life, damage and the SWT product are never stored, and no stress is derived from a strain.
 */
export const FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA = 'pointercad-fatigue-local-cycle-saved/1';
/** The single saved local-cycle configuration of a document; distinct from 'fatigue' and 'fatigue-strain-life'. */
export const FATIGUE_LOCAL_CYCLE_SAVED_ID = 'fatigue-local-cycle';

export interface FatigueLocalCycleSavedCycle {
  readonly strainMeasure: 'local-total-strain';
  readonly strainUnit: 'dimensionless';
  readonly stressUnit: 'MPa';
  readonly derivation: 'measured' | 'elastic-plastic-analysis';
  readonly strainMax: number;
  readonly strainMin: number;
  readonly stressMax: number;
  readonly stressMin: number;
  readonly source: FatigueSavedSource;
}
/** Structurally the LocalCycleInput of @pointercad/fem. */
export interface FatigueLocalCycleSavedProblem {
  readonly schema: 'pointercad-strain-life-local-cycle/1';
  readonly correction: 'morrow' | 'swt';
  readonly material: FatigueStrainSavedMaterial;
  readonly cycle: FatigueLocalCycleSavedCycle;
}
export interface FatigueLocalCycleSavedInput {
  readonly schema: typeof FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA;
  readonly id: typeof FATIGUE_LOCAL_CYCLE_SAVED_ID;
  readonly source: { readonly documentId: string };
  readonly input: FatigueLocalCycleSavedProblem;
}

/** Same bounds and check order as fatigueStrainLife.ts / fatigueLocalCycle.ts of @pointercad/fem;
 * fatigueLocalCyclePersistence.test.ts in the fem package compares the verdicts and paths of both readers. */
const LIMITS = {
  elasticModulusMpa: [1e3, 1e7], fatigueStrengthCoefficientMpa: [1, 1e4], fatigueDuctilityCoefficient: [1e-6, 10],
  exponent: [-2, -1e-3], cycles: [0.5, 1e12], maximumAbsStrain: 1, maximumAbsStressMpa: 1e4,
} as const;

function fail(path: string, message: string): never {
  throw new InputIssue('fatigue-local-cycle', path, message);
}
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  // fields() checks the count and presence; own keys only (an inherited name is not a saved field).
  const row = fields(value, keys, path);
  if (!keys.every(key => Object.hasOwn(row, key))) fail(path, 'Unsupported or missing field');
  return row;
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
function bounded(value: unknown, path: string, limit: number): number {
  const number = finite(value, path);
  if (Math.abs(number) > limit) fail(path, `Expected a magnitude of at most ${limit}`);
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

function readCycle(value: unknown, path: string): FatigueLocalCycleSavedCycle {
  const row = exact(value, ['strainMeasure', 'strainUnit', 'stressUnit', 'derivation', 'strainMax', 'strainMin', 'stressMax',
    'stressMin', 'source'], path);
  if (row.strainMeasure !== 'local-total-strain') fail(`${path}.strainMeasure`, 'Expected a local total strain');
  const derivation = row.derivation;
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') {
    fail(`${path}.derivation`, 'Expected a measured or elastic-plastic local cycle');
  }
  if (row.strainUnit !== 'dimensionless') fail(`${path}.strainUnit`, 'Expected a dimensionless strain');
  if (row.stressUnit !== 'MPa') fail(`${path}.stressUnit`, 'Expected MPa');
  const strainMax = bounded(row.strainMax, `${path}.strainMax`, LIMITS.maximumAbsStrain);
  const strainMin = bounded(row.strainMin, `${path}.strainMin`, LIMITS.maximumAbsStrain);
  const stressMax = bounded(row.stressMax, `${path}.stressMax`, LIMITS.maximumAbsStressMpa);
  const stressMin = bounded(row.stressMin, `${path}.stressMin`, LIMITS.maximumAbsStressMpa);
  if (!(strainMax > strainMin)) fail(`${path}.strainMin`, 'Expected the strain minimum below the strain maximum');
  if (!(stressMax > stressMin)) fail(`${path}.stressMin`, 'Expected the stress minimum below the stress maximum');
  return { strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressUnit: 'MPa', derivation, strainMax,
    strainMin, stressMax, stressMin, source: readSource(row.source, `${path}.source`) };
}

/** Strict reader of the saved problem: the same field sets, bounds, check order and refusals as the solver readers.
 * Domain limits that depend on the solution (Morrow sigma_m < sigma_f', SWT sigma_max > 0, calibrated life) are
 * analysis refusals and are deliberately not saved-format checks, so a user can save and revise such an input. */
export function readFatigueLocalCycleSavedProblem(value: unknown, path: string): FatigueLocalCycleSavedProblem {
  const row = exact(value, ['schema', 'correction', 'material', 'cycle'], path);
  if (row.schema !== 'pointercad-strain-life-local-cycle/1') fail(`${path}.schema`, 'Expected local-cycle input schema 1');
  const correction = row.correction;
  if (correction !== 'morrow' && correction !== 'swt') fail(`${path}.correction`, 'Expected Morrow or SWT');
  return { schema: 'pointercad-strain-life-local-cycle/1', correction, material: readMaterial(row.material, `${path}.material`),
    cycle: readCycle(row.cycle, `${path}.cycle`) };
}

/** Strict reader of the saved configuration. Unknown versions and invalid values are rejected; nothing is coerced. */
export function readFatigueLocalCycleSavedInput(value: unknown, path: string): FatigueLocalCycleSavedInput {
  const row = exact(value, ['schema', 'id', 'source', 'input'], path);
  if (row.schema !== FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA) {
    throw new InputIssue('unsupported-model', path, 'Expected saved local-cycle fatigue schema 1');
  }
  if (row.id !== FATIGUE_LOCAL_CYCLE_SAVED_ID) fail(`${path}.id`, 'Unexpected local-cycle fatigue input id');
  const source = exact(row.source, ['documentId'], `${path}.source`);
  const documentId = text(source.documentId, `${path}.source.documentId`);
  return { schema: FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA, id: FATIGUE_LOCAL_CYCLE_SAVED_ID, source: { documentId },
    input: readFatigueLocalCycleSavedProblem(row.input, `${path}.input`) };
}

/** Writer for an edit: validated by the same reader (throws InputIssue), so a written value is what a later read returns. */
export function createFatigueLocalCycleSavedInput(documentId: string, problem: unknown): FatigueLocalCycleSavedInput {
  return readFatigueLocalCycleSavedInput({ schema: FATIGUE_LOCAL_CYCLE_SAVED_SCHEMA, id: FATIGUE_LOCAL_CYCLE_SAVED_ID,
    source: { documentId }, input: problem }, 'definition');
}
