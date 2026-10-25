/**
 * Paired strain/stress history slice of the low-cycle fatigue work (F1 remaining clause): a uniaxial local TOTAL strain
 * history whose every sample carries the local stress measured or computed AT THE SAME INSTANT, so that each rainflow
 * cycle has a mean stress taken from the actual stresses at its two strain reversals. Only then the existing Morrow
 * correction of the strain-life curve (fatigueStrainLife.ts, elastic term sigma_f' - sigma_m, primary source cited there:
 * Altair OptiStruct uniaxial fatigue, Strain-Life section) is applied per cycle; Miner's linear rule sums count / N_f.
 * The strain-only history (fatigueStrainHistory.ts) is unchanged: it still assumes zero mean stress and refuses Morrow.
 *
 * What is NOT done: no stress is derived from strain (no cyclic stress-strain curve, Masing or Neuber/Glinka mapping),
 * no stress series is matched to a strain series by position or resampled, no material value is built in or
 * extrapolated, no life outside the calibrated interval is reported. Counting is by STRAIN (the strain-life damage
 * parameter); the stress only supplies each cycle's mean. A strain reversal whose plateau (equal consecutive strains)
 * carries different stresses has no single stress at the reversal and is refused, as is a periodic history whose
 * closing samples disagree. Not a code check, certification, multiaxial or notch method.
 *
 * The life counts repeated applications of the whole input. A 'once' record can occur again only after its strain has
 * returned to its first value, so each recurrence is counted closed-loop (as 'repeated-periodic'), with the paired
 * stresses of the same reversal samples; its cycles must lie in the Morrow domain and the calibrated interval too (path
 * histories[i].recurrenceCycles[j]). When the record ends on its first strain with another stress and a recurring cycle
 * uses that wrapped reversal, the stress there is not one value: refused at the last sample, never chosen or invented.
 * The single-pass cycles, paired stresses and damage are reported unchanged.
 */
import { countRainflow, onceReversals, periodicReversals, type FatigueReversal } from './fatigue.js';
import { MAX_FATIGUE_HISTORIES, MAX_FATIGUE_HISTORY_POINTS, MAX_FATIGUE_REPEATS, MAX_FATIGUE_STRESS_MPA,
  type FatigueSequence, type FatigueSource } from './fatigueModel.js';
import { MAX_STRAIN_HISTORY_ABS_STRAIN } from './fatigueStrainHistory.js';
import { STRAIN_LIFE_INPUT_SCHEMA, analyzeStrainLife, validateStrainLifeInput, type StrainLifeAnalysis,
  type StrainLifeCalibration, type StrainLifeErrorCode, type StrainLifeMaterial,
  type StrainLifeStrainDerivation } from './fatigueStrainLife.js';

export const STRAIN_STRESS_HISTORY_INPUT_SCHEMA = 'pointercad-strain-stress-history/1';
export const STRAIN_STRESS_HISTORY_RESULT_SCHEMA = 'pointercad-strain-stress-history-result/1';

/** One sample: the local total strain and the local stress at the same time (tension positive). */
export interface StrainStressSample {
  readonly timeSeconds: number;
  readonly strain: number;
  readonly stressMpa: number;
}
export interface StrainStressHistory {
  readonly id: string;
  readonly strainMeasure: 'local-total-strain';
  readonly strainUnit: 'dimensionless';
  readonly stressMeasure: 'local-stress';
  readonly stressUnit: 'MPa';
  readonly timeUnit: 'second';
  /** How BOTH channels were obtained together (a measured strain with an invented stress is not an option). */
  readonly derivation: StrainLifeStrainDerivation;
  /** Chronological samples, strictly increasing time; each sample pairs the two channels by construction. */
  readonly samples: readonly StrainStressSample[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly source: FatigueSource;
}
export interface StrainStressHistoryInput {
  readonly schema: typeof STRAIN_STRESS_HISTORY_INPUT_SCHEMA;
  /** The mean stress of every cycle is taken from the paired stresses at its reversals and applied with Morrow. */
  readonly meanStress: 'morrow-paired-reversal-stress';
  readonly material: StrainLifeMaterial;
  readonly histories: readonly StrainStressHistory[];
}

export type StrainStressHistoryErrorCode = 'strain-stress-history-shape' | 'strain-stress-history-schema'
  | 'strain-stress-history-id' | 'strain-stress-history-unit' | 'strain-stress-history-measure'
  | 'strain-stress-history-number' | 'strain-stress-history-bound' | 'strain-stress-history-length'
  | 'strain-stress-history-time-order' | 'strain-stress-history-sequence' | 'strain-stress-history-repeats'
  | 'strain-stress-history-source' | 'strain-stress-history-mean-assumption'
  | 'strain-stress-history-ambiguous-reversal-stress' | 'strain-stress-history-periodic-closure'
  | 'strain-stress-history-recurrence-closure';
export interface StrainStressHistoryError {
  readonly ok: false;
  readonly code: StrainStressHistoryErrorCode | StrainLifeErrorCode;
  /** Names the failing sample (histories[i].samples[k].field) or the failing cycle (histories[i].cycles[j]). */
  readonly path: string;
}
export type StrainStressHistoryValidation = { readonly ok: true; readonly input: StrainStressHistoryInput } | StrainStressHistoryError;

export interface StrainStressHistoryCycle {
  readonly count: 0.5 | 1;
  readonly strainRange: number;
  readonly strainAmplitude: number;
  readonly meanStrain: number;
  /** Sample indices (plateau starts) of the two strain reversals of the cycle, in counting order. */
  readonly fromIndex: number;
  readonly toIndex: number;
  /** The paired stresses at those two reversals and their mean: the cycle's mean stress, tension positive. */
  readonly stressAtFromMpa: number;
  readonly stressAtToMpa: number;
  readonly meanStressMpa: number;
  readonly cyclesToFailure: number;
}
export interface StrainStressHistoryResultEntry {
  readonly id: string;
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly reversals: number;
  readonly cycles: readonly StrainStressHistoryCycle[];
  readonly damage: number;
}
export type StrainStressHistoryLife = { readonly kind: 'finite'; readonly spectrumRepetitions: number }
  | { readonly kind: 'no-strain-cycle' };
export interface StrainStressHistoryResult {
  readonly schema: typeof STRAIN_STRESS_HISTORY_RESULT_SCHEMA;
  readonly method: 'rainflow-three-point-stack/1+paired-reversal-stress/1+basquin-coffin-manson/1+morrow-elastic-term/1+miner-linear/1';
  readonly scope: 'uniaxial-local-total-strain-history-with-paired-local-stress-linear-damage-estimate';
  readonly meanStress: 'morrow-paired-reversal-stress';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly materialId: string;
  readonly calibration: StrainLifeCalibration;
  readonly histories: readonly StrainStressHistoryResultEntry[];
  readonly damage: number;
  readonly life: StrainStressHistoryLife;
}
export type StrainStressHistoryAnalysis = { readonly ok: true; readonly result: StrainStressHistoryResult } | StrainStressHistoryError;

const fail = (code: StrainStressHistoryErrorCode, path: string): StrainStressHistoryError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readSource(value: unknown, path: string): FatigueSource | StrainStressHistoryError {
  if (!record(value) || !exactKeys(value, ['kind', 'reference', 'condition'])) return fail('strain-stress-history-shape', path);
  if (value.kind !== 'user-supplied' || !text(value.reference, 512) || !text(value.condition, 512)) {
    return fail('strain-stress-history-source', path);
  }
  return { kind: 'user-supplied', reference: value.reference, condition: value.condition };
}

/** The strain-life input of one counted cycle with the Morrow correction and the cycle's paired mean stress. */
function curveInput(material: unknown, strainAmplitude: number, meanStressMpa: number, derivation: StrainLifeStrainDerivation,
  source: FatigueSource): Record<string, unknown> {
  return { schema: STRAIN_LIFE_INPUT_SCHEMA, meanStressCorrection: 'morrow', material,
    loading: { strainMeasure: 'local-total-strain-amplitude', strainUnit: 'dimensionless', derivation, strainAmplitude,
      meanStressMpa, source } };
}
const PROBE_SOURCE: FatigueSource = { kind: 'user-supplied', reference: 'Material validation probe; not a load',
  condition: 'Validates the material only' };
/** The strain-life reader checks the material before the loading; with this valid probe loading (mean 0, Morrow)
 * every refusal is a material refusal with its own code and material.* path. The probe is never analysed. */
function readMaterial(value: unknown): StrainLifeMaterial | StrainStressHistoryError {
  const checked = validateStrainLifeInput(curveInput(value, 1, 0, 'measured', PROBE_SOURCE));
  return checked.ok ? checked.input.material : { ok: false, code: checked.code, path: checked.path };
}

function readSample(value: unknown, path: string): StrainStressSample | StrainStressHistoryError {
  if (!record(value) || !exactKeys(value, ['timeSeconds', 'strain', 'stressMpa'])) return fail('strain-stress-history-shape', path);
  const timeSeconds = value.timeSeconds, strain = value.strain, stressMpa = value.stressMpa;
  if (!finite(timeSeconds)) return fail('strain-stress-history-number', `${path}.timeSeconds`);
  if (!finite(strain)) return fail('strain-stress-history-number', `${path}.strain`);
  if (!finite(stressMpa)) return fail('strain-stress-history-number', `${path}.stressMpa`);
  if (Math.abs(strain) > MAX_STRAIN_HISTORY_ABS_STRAIN) return fail('strain-stress-history-bound', `${path}.strain`);
  if (Math.abs(stressMpa) > MAX_FATIGUE_STRESS_MPA) return fail('strain-stress-history-bound', `${path}.stressMpa`);
  return { timeSeconds, strain, stressMpa };
}

function readHistory(value: unknown, path: string): StrainStressHistory | StrainStressHistoryError {
  const keys = ['id', 'strainMeasure', 'strainUnit', 'stressMeasure', 'stressUnit', 'timeUnit', 'derivation', 'samples',
    'sequence', 'repeats', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('strain-stress-history-shape', path);
  if (!text(value.id, 64)) return fail('strain-stress-history-id', `${path}.id`);
  if (value.strainMeasure !== 'local-total-strain') return fail('strain-stress-history-measure', `${path}.strainMeasure`);
  if (value.stressMeasure !== 'local-stress') return fail('strain-stress-history-measure', `${path}.stressMeasure`);
  const derivation = value.derivation;
  if (derivation !== 'measured' && derivation !== 'elastic-plastic-analysis') {
    return fail('strain-stress-history-measure', `${path}.derivation`);
  }
  if (value.strainUnit !== 'dimensionless') return fail('strain-stress-history-unit', `${path}.strainUnit`);
  if (value.stressUnit !== 'MPa') return fail('strain-stress-history-unit', `${path}.stressUnit`);
  if (value.timeUnit !== 'second') return fail('strain-stress-history-unit', `${path}.timeUnit`);
  const rows = value.samples;
  if (!dense(rows)) return fail('strain-stress-history-shape', `${path}.samples`);
  if (rows.length < 1 || rows.length > MAX_FATIGUE_HISTORY_POINTS) return fail('strain-stress-history-length', `${path}.samples`);
  const samples: StrainStressSample[] = [];
  for (const [index, row] of rows.entries()) {
    const sample = readSample(row, `${path}.samples[${index}]`);
    if ('ok' in sample) return sample;
    // Strictly increasing time: a repeated or earlier time is a duplicated or reordered sample, never merged or sorted.
    const previous = samples.at(-1);
    if (previous !== undefined && !(sample.timeSeconds > previous.timeSeconds)) {
      return fail('strain-stress-history-time-order', `${path}.samples[${index}].timeSeconds`);
    }
    samples.push(sample);
  }
  const sequence = value.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') return fail('strain-stress-history-sequence', `${path}.sequence`);
  const repeats = value.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_FATIGUE_REPEATS
    || (sequence === 'once' && repeats !== 1)) return fail('strain-stress-history-repeats', `${path}.repeats`);
  const source = readSource(value.source, `${path}.source`);
  if ('ok' in source) return source;
  return { id: value.id, strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', stressMeasure: 'local-stress',
    stressUnit: 'MPa', timeUnit: 'second', derivation, samples, sequence, repeats, source };
}

/** Strict reader of unknown data; returns fresh values so later caller mutation cannot change an analysis. */
export function validateStrainStressHistoryInput(value: unknown): StrainStressHistoryValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'meanStress', 'material', 'histories'])) {
    return fail('strain-stress-history-shape', '$');
  }
  if (value.schema !== STRAIN_STRESS_HISTORY_INPUT_SCHEMA) return fail('strain-stress-history-schema', 'schema');
  if (value.meanStress !== 'morrow-paired-reversal-stress') return fail('strain-stress-history-mean-assumption', 'meanStress');
  const material = readMaterial(value.material);
  if ('ok' in material) return material;
  const rows = value.histories;
  if (!dense(rows)) return fail('strain-stress-history-shape', 'histories');
  if (rows.length < 1 || rows.length > MAX_FATIGUE_HISTORIES) return fail('strain-stress-history-length', 'histories');
  const histories: StrainStressHistory[] = [];
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const history = readHistory(row, `histories[${index}]`);
    if ('ok' in history) return history;
    if (ids.has(history.id)) return fail('strain-stress-history-id', `histories[${index}].id`);
    ids.add(history.id);
    histories.push(history);
  }
  return { ok: true, input: { schema: STRAIN_STRESS_HISTORY_INPUT_SCHEMA, meanStress: 'morrow-paired-reversal-stress', material,
    histories } };
}

/**
 * The stress at every strain reversal of one history, or the first sample that makes it ambiguous. A reversal index is
 * the first sample of a plateau of equal strains (fatigue.ts plateaus); every sample of that plateau must carry the same
 * stress. For a periodic history the closing plateau (the last samples equal to the first strain) belongs to the first
 * plateau, so its stresses must agree with it too.
 */
export function pairedReversalStress(history: Pick<StrainStressHistory, 'samples' | 'sequence'>, path: string):
  { readonly ok: true; readonly stressAt: ReadonlyMap<number, number> } | StrainStressHistoryError {
  const { samples } = history;
  const stressAt = new Map<number, number>();
  let start = 0;
  for (let index = 1; index <= samples.length; index += 1) {
    const first = samples[start], current = samples[index];
    if (first === undefined) break;
    if (current !== undefined && current.strain === first.strain) {
      if (current.stressMpa !== first.stressMpa) {
        return fail('strain-stress-history-ambiguous-reversal-stress', `${path}.samples[${index}].stressMpa`);
      }
      continue;
    }
    stressAt.set(start, first.stressMpa);
    start = index;
  }
  if (history.sequence === 'repeated-periodic' && samples.length > 1) {
    const head = samples[0], tail = samples.at(-1);
    if (head !== undefined && tail !== undefined && tail.strain === head.strain && tail.stressMpa !== head.stressMpa) {
      return fail('strain-stress-history-periodic-closure', `${path}.samples[${samples.length - 1}].stressMpa`);
    }
  }
  return { ok: true, stressAt };
}

/** The paired stress of one reversal (always present for a reversal of the same samples; a missing entry is a refusal). */
function stressOf(stressAt: ReadonlyMap<number, number>, reversal: Pick<FatigueReversal, 'index'>): number | undefined {
  return stressAt.get(reversal.index);
}

/**
 * The closed-loop cycles of one recurrence of a 'once' record. On recurrence the last plateau joins the first one when
 * both have the same strain; if they carry different stresses and a recurring cycle uses that wrapped reversal (sample
 * 0), the reversal has no single stress and the record is refused at its last sample. When the wrapped point is not a
 * reversal of the closed loop (it lies between a valley and a peak), its stress is not used and nothing is refused.
 */
function recurrenceCycles(history: StrainStressHistory, path: string):
  { readonly ok: true; readonly cycles: ReturnType<typeof countRainflow> } | StrainStressHistoryError {
  const { samples } = history;
  const cycles = countRainflow(periodicReversals(samples.map(sample => sample.strain)));
  const head = samples[0], tail = samples.at(-1);
  if (samples.length > 1 && head !== undefined && tail !== undefined && tail.strain === head.strain
    && tail.stressMpa !== head.stressMpa && cycles.some(cycle => cycle.fromIndex === 0 || cycle.toIndex === 0)) {
    return fail('strain-stress-history-recurrence-closure', `${path}.samples[${samples.length - 1}].stressMpa`);
  }
  return { ok: true, cycles };
}

/**
 * Counts every history by strain with the existing rainflow core, takes each cycle's mean stress from the paired
 * stresses at its two reversals, solves the strain-life curve with the existing Morrow correction and sums Miner
 * damage. A cycle whose mean stress is outside the Morrow domain (sigma_f' <= sigma_m) or whose life is outside the
 * calibrated interval refuses the whole analysis with the cycle's path; no cycle is dropped and no partial life reported.
 * `damage` is one application of the input; `life` counts repeated applications, each 'once' record closed-loop.
 */
export function analyzeStrainStressHistory(value: unknown): StrainStressHistoryAnalysis {
  const checked = validateStrainStressHistoryInput(value);
  if (!checked.ok) return checked;
  const { material, histories } = checked.input;
  // The life depends only on (amplitude, mean stress) for one material and derivation; repeats are solved once.
  const lives = new Map<string, StrainLifeAnalysis>();
  const lifeOf = (strainAmplitude: number, meanStressMpa: number, history: StrainStressHistory): StrainLifeAnalysis => {
    const key = `${String(strainAmplitude)}|${String(meanStressMpa)}|${history.derivation}`;
    let life = lives.get(key);
    if (life === undefined) {
      life = analyzeStrainLife(curveInput(material, strainAmplitude, meanStressMpa, history.derivation, history.source));
      lives.set(key, life);
    }
    return life;
  };
  const results: StrainStressHistoryResultEntry[] = [];
  let total = 0, repeated = 0, counted = 0;
  for (const [at, history] of histories.entries()) {
    const path = `histories[${at}]`;
    const paired = pairedReversalStress(history, path);
    if (!paired.ok) return paired;
    const strain = history.samples.map(sample => sample.strain);
    const reversals = history.sequence === 'once' ? onceReversals(strain) : periodicReversals(strain);
    const cycles: StrainStressHistoryCycle[] = [];
    let damage = 0;
    for (const [index, cycle] of countRainflow(reversals).entries()) {
      // countRainflow names its fields for stress; here rangeMpa / meanMpa hold the dimensionless strain values.
      const stressAtFromMpa = stressOf(paired.stressAt, { index: cycle.fromIndex });
      const stressAtToMpa = stressOf(paired.stressAt, { index: cycle.toIndex });
      if (stressAtFromMpa === undefined || stressAtToMpa === undefined) {
        return fail('strain-stress-history-ambiguous-reversal-stress', `${path}.cycles[${index}]`);
      }
      const strainAmplitude = cycle.rangeMpa / 2;
      const meanStressMpa = (stressAtFromMpa + stressAtToMpa) / 2;
      const life = lifeOf(strainAmplitude, meanStressMpa, history);
      if (!life.ok) return { ok: false, code: life.code, path: `${path}.cycles[${index}]` };
      cycles.push({ count: cycle.count, strainRange: cycle.rangeMpa, strainAmplitude, meanStrain: cycle.meanMpa,
        fromIndex: cycle.fromIndex, toIndex: cycle.toIndex, stressAtFromMpa, stressAtToMpa, meanStressMpa,
        cyclesToFailure: life.result.cyclesToFailure });
      damage += cycle.count * life.result.damagePerCycle;
    }
    damage *= history.repeats;
    let recurringDamage = damage;
    if (history.sequence === 'once') {
      // One recurrence of the record (repeats is 1), with the paired stresses of the same reversal samples.
      const recurring = recurrenceCycles(history, path);
      if (!recurring.ok) return recurring;
      recurringDamage = 0;
      for (const [index, cycle] of recurring.cycles.entries()) {
        const from = stressOf(paired.stressAt, { index: cycle.fromIndex }), to = stressOf(paired.stressAt, { index: cycle.toIndex });
        if (from === undefined || to === undefined) {
          return fail('strain-stress-history-ambiguous-reversal-stress', `${path}.recurrenceCycles[${index}]`);
        }
        const life = lifeOf(cycle.rangeMpa / 2, (from + to) / 2, history);
        if (!life.ok) return { ok: false, code: life.code, path: `${path}.recurrenceCycles[${index}]` };
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
  const life: StrainStressHistoryLife = counted === 0 ? { kind: 'no-strain-cycle' }
    : { kind: 'finite', spectrumRepetitions: 1 / repeated };
  return { ok: true, result: { schema: STRAIN_STRESS_HISTORY_RESULT_SCHEMA,
    method: 'rainflow-three-point-stack/1+paired-reversal-stress/1+basquin-coffin-manson/1+morrow-elastic-term/1+miner-linear/1',
    scope: 'uniaxial-local-total-strain-history-with-paired-local-stress-linear-damage-estimate',
    meanStress: 'morrow-paired-reversal-stress', codeCompliance: false, structuralCertification: false,
    materialId: material.id, calibration: material.calibration, histories: results, damage: total, life } };
}
