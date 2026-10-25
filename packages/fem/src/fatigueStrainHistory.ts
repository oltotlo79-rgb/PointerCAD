/**
 * Strain-history slice of the low-cycle fatigue work: uniaxial local TOTAL strain histories are counted with the
 * existing rainflow core of fatigue.ts, each counted cycle gets its life from the strain-life curve of
 * fatigueStrainLife.ts (amplitude = range / 2), and Miner's linear rule sums count / N_f. The stress-life and Goodman
 * APIs are unchanged. Not a code check, certification, multiaxial or notch (Neuber, Glinka) method.
 * Mean stress: a strain history does not determine the mean stress of its cycles (it depends on the cyclic stress-strain
 * response and on the loading order), so the only accepted assumption in this slice is the user's explicit statement
 * that every counted cycle has zero mean stress ('assumed-zero'; the strain-life curve applied as fitted). A Morrow
 * correction needs a validated stress at each reversal and is refused here instead of inventing a mapping.
 * Every counted cycle must lie inside the calibrated life interval: a cycle above or below it refuses the whole
 * analysis (path histories[i].cycles[j]); no cycle is dropped and no partial life is reported.
 * The life counts repeated applications of the whole input. A 'once' record can occur again only after its strain has
 * returned to its first value, so each recurrence is counted closed-loop (the same closure as 'repeated-periodic'); its
 * cycles must lie inside the calibrated interval too (path histories[i].recurrenceCycles[j]). The single-pass cycles and
 * damage are reported unchanged; a further excursion between occurrences is not in the record and is not counted.
 */
import { countRainflow, onceReversals, periodicReversals } from './fatigue.js';
import { MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS, type FatigueSequence,
  type FatigueSource } from './fatigueModel.js';
import { STRAIN_LIFE_INPUT_SCHEMA, analyzeStrainLife, validateStrainLifeInput, type StrainLifeAnalysis,
  type StrainLifeCalibration, type StrainLifeErrorCode, type StrainLifeMaterial,
  type StrainLifeStrainDerivation } from './fatigueStrainLife.js';

export const STRAIN_HISTORY_INPUT_SCHEMA = 'pointercad-strain-history/1';
export const STRAIN_HISTORY_RESULT_SCHEMA = 'pointercad-strain-history-result/1';
/** |strain| above 1 (100 %) is refused as a unit error (for example microstrain integers); not a material limit. */
export const MAX_STRAIN_HISTORY_ABS_STRAIN = 1;

export interface StrainHistory {
  readonly id: string;
  readonly strainMeasure: 'local-total-strain';
  readonly strainUnit: 'dimensionless';
  readonly derivation: StrainLifeStrainDerivation;
  /** One local total strain per point, in chronological order (tension positive). */
  readonly strain: readonly number[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly source: FatigueSource;
}
export interface StrainHistoryInput {
  readonly schema: typeof STRAIN_HISTORY_INPUT_SCHEMA;
  /** The user's explicit statement that every counted cycle has zero mean stress. */
  readonly meanStress: 'assumed-zero';
  readonly material: StrainLifeMaterial;
  readonly histories: readonly StrainHistory[];
}

export type StrainHistoryErrorCode = 'strain-history-shape' | 'strain-history-schema' | 'strain-history-id'
  | 'strain-history-unit' | 'strain-history-number' | 'strain-history-bound' | 'strain-history-length'
  | 'strain-history-strain-measure' | 'strain-history-sequence' | 'strain-history-repeats' | 'strain-history-source'
  | 'strain-history-mean-assumption' | 'strain-history-mean-unsupported';
/** Material refusals and per-cycle curve refusals keep the strain-life code; a cycle refusal's path names the cycle. */
export interface StrainHistoryError {
  readonly ok: false;
  readonly code: StrainHistoryErrorCode | StrainLifeErrorCode;
  readonly path: string;
}
export type StrainHistoryValidation = { readonly ok: true; readonly input: StrainHistoryInput } | StrainHistoryError;

/** One rainflow cycle of a strain history: count 1 (closed) or 0.5 (half); indices are plateau starts. */
export interface StrainHistoryCycle {
  readonly count: 0.5 | 1;
  readonly strainRange: number;
  readonly strainAmplitude: number;
  /** Reported only; it is not converted to a mean stress. */
  readonly meanStrain: number;
  readonly fromIndex: number;
  readonly toIndex: number;
  readonly cyclesToFailure: number;
}
export interface StrainHistoryResultEntry {
  readonly id: string;
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly reversals: number;
  readonly cycles: readonly StrainHistoryCycle[];
  /** Miner damage of this history including its repeats; 0 when it has no cycle. */
  readonly damage: number;
}
/** No counted cycle at all is a typed outcome, never an infinite or finite stand-in life. */
export type StrainHistoryLife = { readonly kind: 'finite'; readonly spectrumRepetitions: number }
  | { readonly kind: 'no-strain-cycle' };
export interface StrainHistoryResult {
  readonly schema: typeof STRAIN_HISTORY_RESULT_SCHEMA;
  readonly method: 'rainflow-three-point-stack/1+basquin-coffin-manson/1+miner-linear/1';
  readonly scope: 'uniaxial-local-total-strain-history-linear-damage-estimate';
  readonly meanStress: 'assumed-zero';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly materialId: string;
  readonly calibration: StrainLifeCalibration;
  readonly histories: readonly StrainHistoryResultEntry[];
  /** Sum of count / N_f over every counted cycle of every history, with repeats; not a probability of failure. */
  readonly damage: number;
  /** How many times the whole input (all histories with their repeats) could be applied until damage 1. */
  readonly life: StrainHistoryLife;
}
export type StrainHistoryAnalysis = { readonly ok: true; readonly result: StrainHistoryResult } | StrainHistoryError;

const fail = (code: StrainHistoryErrorCode, path: string): StrainHistoryError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Holes are refused (map/every skip them), the same rule as the stress-history reader. */
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readSource(value: unknown, path: string): FatigueSource | StrainHistoryError {
  if (!record(value) || !exactKeys(value, ['kind', 'reference', 'condition'])) return fail('strain-history-shape', path);
  if (value.kind !== 'user-supplied' || !text(value.reference, 512) || !text(value.condition, 512)) {
    return fail('strain-history-source', path);
  }
  return { kind: 'user-supplied', reference: value.reference, condition: value.condition };
}

/** A zero-mean-stress local total strain amplitude input of the strain-life contract (material still unknown data
 * when probing; the strain-life reader validates it either way). */
function curveInput(material: unknown, strainAmplitude: number, derivation: StrainLifeStrainDerivation,
  source: FatigueSource): Record<string, unknown> {
  return { schema: STRAIN_LIFE_INPUT_SCHEMA, meanStressCorrection: 'none', material,
    loading: { strainMeasure: 'local-total-strain-amplitude', strainUnit: 'dimensionless', derivation, strainAmplitude,
      meanStressMpa: 0, source } };
}
const PROBE_SOURCE: FatigueSource = { kind: 'user-supplied', reference: 'Material validation probe; not a load',
  condition: 'Validates the material only' };
/** The strain-life reader checks the material before the loading, so with this valid probe loading every refusal is a
 * material refusal, reported with its own code and material.* path. The probe amplitude is never analysed. */
function readMaterial(value: unknown): StrainLifeMaterial | StrainHistoryError {
  const checked = validateStrainLifeInput(curveInput(value, 1, 'measured', PROBE_SOURCE));
  return checked.ok ? checked.input.material : checked;
}

function readHistory(value: unknown, path: string): StrainHistory | StrainHistoryError {
  const keys = ['id', 'strainMeasure', 'strainUnit', 'derivation', 'strain', 'sequence', 'repeats', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('strain-history-shape', path);
  if (!text(value.id, 64)) return fail('strain-history-id', `${path}.id`);
  if (value.strainMeasure !== 'local-total-strain') return fail('strain-history-strain-measure', `${path}.strainMeasure`);
  const derivation = value.derivation;
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') {
    return fail('strain-history-strain-measure', `${path}.derivation`);
  }
  if (value.strainUnit !== 'dimensionless') return fail('strain-history-unit', `${path}.strainUnit`);
  const points = value.strain;
  if (!dense(points)) return fail('strain-history-shape', `${path}.strain`);
  if (points.length < 1 || points.length > MAX_FATIGUE_HISTORY_POINTS) return fail('strain-history-length', `${path}.strain`);
  const strain: number[] = [];
  for (const [index, point] of points.entries()) {
    if (!finite(point)) return fail('strain-history-number', `${path}.strain[${index}]`);
    if (Math.abs(point) > MAX_STRAIN_HISTORY_ABS_STRAIN) return fail('strain-history-bound', `${path}.strain[${index}]`);
    strain.push(point);
  }
  const sequence = value.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') return fail('strain-history-sequence', `${path}.sequence`);
  const repeats = value.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_FATIGUE_REPEATS
    || (sequence === 'once' && repeats !== 1)) return fail('strain-history-repeats', `${path}.repeats`);
  const source = readSource(value.source, `${path}.source`);
  if ('ok' in source) return source;
  return { id: value.id, strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation, strain, sequence,
    repeats, source };
}

/** Strict reader of unknown data; returns fresh values so later caller mutation cannot change an analysis. */
export function validateStrainHistoryInput(value: unknown): StrainHistoryValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'meanStress', 'material', 'histories'])) {
    return fail('strain-history-shape', '$');
  }
  if (value.schema !== STRAIN_HISTORY_INPUT_SCHEMA) return fail('strain-history-schema', 'schema');
  if (value.meanStress === 'morrow') return fail('strain-history-mean-unsupported', 'meanStress');
  if (value.meanStress !== 'assumed-zero') return fail('strain-history-mean-assumption', 'meanStress');
  const material = readMaterial(value.material);
  if ('ok' in material) return material;
  const rows = value.histories;
  if (!dense(rows)) return fail('strain-history-shape', 'histories');
  if (rows.length < 1 || rows.length > MAX_FATIGUE_HISTORIES) return fail('strain-history-length', 'histories');
  const histories: StrainHistory[] = [];
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const history = readHistory(row, `histories[${index}]`);
    if ('ok' in history) return history;
    if (ids.has(history.id)) return fail('strain-history-id', `histories[${index}].id`);
    ids.add(history.id);
    histories.push(history);
  }
  return { ok: true, input: { schema: STRAIN_HISTORY_INPUT_SCHEMA, meanStress: 'assumed-zero', material, histories } };
}

/**
 * Counts every history with the stress-history rainflow core (unit-free reversal values), takes each cycle's life from
 * the strain-life curve and sums Miner damage. With the curve's interval limits every life is in [0.5, 1e12] cycles, so
 * a damage term is in [5e-13, 2] per cycle and the total is at most 2 * 1e5 * 1e9 * 64 < 1.3e16: finite and positive
 * whenever a cycle exists. Typed refusals, never a thrown TypeError, a dropped cycle or a partial life.
 * `damage` is one application of the input; `life` counts repeated applications, each 'once' record closed-loop.
 */
export function analyzeStrainHistory(value: unknown): StrainHistoryAnalysis {
  const checked = validateStrainHistoryInput(value);
  if (!checked.ok) return checked;
  const { material, histories } = checked.input;
  // The life depends only on the amplitude for one material; repeated amplitudes are solved once.
  const lives = new Map<number, StrainLifeAnalysis>();
  const lifeOf = (strainAmplitude: number, history: StrainHistory): StrainLifeAnalysis => {
    let life = lives.get(strainAmplitude);
    if (life === undefined) {
      life = analyzeStrainLife(curveInput(material, strainAmplitude, history.derivation, history.source));
      lives.set(strainAmplitude, life);
    }
    return life;
  };
  const results: StrainHistoryResultEntry[] = [];
  let total = 0, repeated = 0, counted = 0;
  for (const [at, history] of histories.entries()) {
    const reversals = history.sequence === 'once' ? onceReversals(history.strain) : periodicReversals(history.strain);
    const cycles: StrainHistoryCycle[] = [];
    let damage = 0;
    for (const [index, cycle] of countRainflow(reversals).entries()) {
      // countRainflow names its fields for stress; here rangeMpa / meanMpa hold the dimensionless strain values.
      const strainAmplitude = cycle.rangeMpa / 2;
      const life = lifeOf(strainAmplitude, history);
      if (!life.ok) return { ok: false, code: life.code, path: `histories[${at}].cycles[${index}]` };
      cycles.push({ count: cycle.count, strainRange: cycle.rangeMpa, strainAmplitude, meanStrain: cycle.meanMpa,
        fromIndex: cycle.fromIndex, toIndex: cycle.toIndex, cyclesToFailure: life.result.cyclesToFailure });
      damage += cycle.count * life.result.damagePerCycle;
    }
    damage *= history.repeats;
    let recurringDamage = damage;
    if (history.sequence === 'once') {
      // One recurrence of the record (repeats is 1): the closed-loop cycles, each inside the calibrated interval.
      recurringDamage = 0;
      for (const [index, cycle] of countRainflow(periodicReversals(history.strain)).entries()) {
        const life = lifeOf(cycle.rangeMpa / 2, history);
        if (!life.ok) return { ok: false, code: life.code, path: `histories[${at}].recurrenceCycles[${index}]` };
        recurringDamage += cycle.count * life.result.damagePerCycle;
      }
    }
    total += damage;
    repeated += recurringDamage;
    counted += cycles.length;
    results.push({ id: history.id, sequence: history.sequence, repeats: history.repeats, reversals: reversals.length,
      cycles, damage });
  }
  // A record with no single-pass cycle is constant, so its recurrence has none either.
  const life: StrainHistoryLife = counted === 0 ? { kind: 'no-strain-cycle' }
    : { kind: 'finite', spectrumRepetitions: 1 / repeated };
  return { ok: true, result: { schema: STRAIN_HISTORY_RESULT_SCHEMA,
    method: 'rainflow-three-point-stack/1+basquin-coffin-manson/1+miner-linear/1',
    scope: 'uniaxial-local-total-strain-history-linear-damage-estimate', meanStress: 'assumed-zero', codeCompliance: false,
    structuralCertification: false, materialId: material.id, calibration: material.calibration, histories: results,
    damage: total, life } };
}
