/**
 * First fatigue slice of the steel-beam workflow (not the whole fatigue feature): uniaxial scalar stress histories,
 * rainflow cycle counting and Miner linear cumulative damage against ONE user-supplied single-slope S-N relation.
 * Nothing here is a code check, certification, multiaxial or plastic (low-cycle) fatigue method, and no material
 * strength, endurance limit or safety factor is inferred. The legacy API applies no mean-stress correction; the
 * separate explicit opt-in contract follows the legacy types below. Every curve value, its stress
 * definition (range or amplitude), its mean-stress applicability and its source are explicit user inputs.
 * Stresses are MPa (= N/mm2) throughout; there is no unit conversion.
 */

export const FATIGUE_INPUT_SCHEMA = 'pointercad-fatigue/1';
export const FATIGUE_RESULT_SCHEMA = 'pointercad-fatigue-result/1';
/** 1e4 MPa is far above any structural steel strength, and with the curve bounds below every damage term stays
 * finite: ((2e4 / 1) ** 20) * 1e9 repeats * 1e5 cycles / 1 < 1e110, far below Number.MAX_VALUE. */
export const MAX_FATIGUE_STRESS_MPA = 1e4;
export const MAX_FATIGUE_HISTORY_POINTS = 100_000;
export const MAX_FATIGUE_HISTORIES = 64;
export const MAX_FATIGUE_REPEATS = 1e9;
export const FATIGUE_SLOPE_LIMITS = { minimum: 1, maximum: 20 } as const;
export const FATIGUE_REFERENCE_STRESS_LIMITS_MPA = { minimum: 1, maximum: MAX_FATIGUE_STRESS_MPA } as const;
export const FATIGUE_REFERENCE_CYCLE_LIMITS = { minimum: 1, maximum: 1e12 } as const;
/** fully-reversed-only: a counted cycle is fully reversed when |mean| <= this x the largest |stress| of its history. */
export const FATIGUE_REVERSED_MEAN_TOLERANCE = 1e-9;

/** What the curve's stress axis means. There is no default: an unidentified convention is a factor-of-two error. */
export type FatigueStressDefinition = 'range' | 'amplitude';
/**
 * How the single curve may be applied to cycles with a nonzero mean (no correction is ever applied):
 * - 'mean-independent': the user states the curve applies to every counted cycle regardless of its mean;
 * - 'fully-reversed-only': the curve is valid only for fully reversed cycles; any cycle with a nonzero mean is refused.
 */
export type FatigueMeanStressAssumption = 'mean-independent' | 'fully-reversed-only';
/** 'once': the history is one chronological event (residual half cycles stay half cycles), repeats must be 1.
 * 'repeated-periodic': the history is one period of a loading repeated `repeats` times (closed-loop counting). */
export type FatigueSequence = 'once' | 'repeated-periodic';

export interface FatigueSource {
  readonly kind: 'user-supplied';
  /** Where the user took the curve or history from (standard, test report, own analysis); required, not checked. */
  readonly reference: string;
  readonly condition: string;
}
/** N = referenceCycles * (referenceStressMpa / S) ** slope for S >= cutoffStressMpa (or every S > 0 when null). */
export interface FatigueSnCurve {
  readonly id: string;
  readonly unit: 'MPa';
  readonly stressDefinition: FatigueStressDefinition;
  readonly meanStressAssumption: FatigueMeanStressAssumption;
  readonly referenceStressMpa: number;
  readonly referenceCycles: number;
  readonly slope: number;
  /** Below this stress (same definition) a cycle contributes no damage; null means no cut-off. Explicit, no default. */
  readonly cutoffStressMpa: number | null;
  readonly source: FatigueSource;
}
export interface FatigueStressHistory {
  readonly id: string;
  readonly unit: 'MPa';
  /** One scalar stress per point, in chronological order (tension positive). */
  readonly stressMpa: readonly number[];
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly source: FatigueSource;
}
export interface FatigueInput {
  readonly schema: typeof FATIGUE_INPUT_SCHEMA;
  readonly curve: FatigueSnCurve;
  readonly histories: readonly FatigueStressHistory[];
}

export type FatigueErrorCode = 'fatigue-shape' | 'fatigue-schema' | 'fatigue-id' | 'fatigue-unit' | 'fatigue-number'
  | 'fatigue-bound' | 'fatigue-history' | 'fatigue-curve-convention' | 'fatigue-mean-assumption' | 'fatigue-sequence'
  | 'fatigue-repeats' | 'fatigue-source' | 'fatigue-mean' | 'fatigue-overflow';
export interface FatigueError { readonly ok: false; readonly code: FatigueErrorCode; readonly path: string }
export type FatigueValidation = { readonly ok: true; readonly input: FatigueInput } | FatigueError;

const fail = (code: FatigueErrorCode, path: string): FatigueError => ({ ok: false, code, path });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** Unknown runtime data: holes are refused (map/every skip them), the same rule as the contact and transient readers. */
const dense = (value: unknown): value is unknown[] => {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
};
const text = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readSource(value: unknown, path: string): FatigueSource | FatigueError {
  if (!record(value) || !exactKeys(value, ['kind', 'reference', 'condition'])) return fail('fatigue-shape', path);
  if (value.kind !== 'user-supplied' || !text(value.reference, 512) || !text(value.condition, 512)) {
    return fail('fatigue-source', path);
  }
  return { kind: 'user-supplied', reference: value.reference, condition: value.condition };
}

export function readFatigueSnCurve(value: unknown): FatigueSnCurve | FatigueError {
  const keys = ['id', 'unit', 'stressDefinition', 'meanStressAssumption', 'referenceStressMpa', 'referenceCycles', 'slope',
    'cutoffStressMpa', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('fatigue-shape', 'curve');
  if (!text(value.id, 64)) return fail('fatigue-id', 'curve.id');
  if (value.unit !== 'MPa') return fail('fatigue-unit', 'curve.unit');
  const definition = value.stressDefinition;
  if (definition !== 'range' && definition !== 'amplitude') return fail('fatigue-curve-convention', 'curve.stressDefinition');
  const mean = value.meanStressAssumption;
  if (mean !== 'mean-independent' && mean !== 'fully-reversed-only') return fail('fatigue-mean-assumption', 'curve.meanStressAssumption');
  const numbers = [['referenceStressMpa', FATIGUE_REFERENCE_STRESS_LIMITS_MPA], ['referenceCycles', FATIGUE_REFERENCE_CYCLE_LIMITS],
    ['slope', FATIGUE_SLOPE_LIMITS]] as const;
  for (const [key, limits] of numbers) {
    const number = value[key];
    if (!finite(number)) return fail('fatigue-number', `curve.${key}`);
    if (number < limits.minimum || number > limits.maximum) return fail('fatigue-bound', `curve.${key}`);
  }
  const cutoff = value.cutoffStressMpa;
  let cutoffStressMpa: number | null = null;
  if (cutoff !== null) {
    if (!finite(cutoff)) return fail('fatigue-number', 'curve.cutoffStressMpa');
    if (cutoff <= 0 || cutoff > MAX_FATIGUE_STRESS_MPA * 2) return fail('fatigue-bound', 'curve.cutoffStressMpa');
    cutoffStressMpa = cutoff;
  }
  const source = readSource(value.source, 'curve.source');
  if ('ok' in source) return source;
  return { id: value.id, unit: 'MPa', stressDefinition: definition, meanStressAssumption: mean,
    referenceStressMpa: Number(value.referenceStressMpa), referenceCycles: Number(value.referenceCycles), slope: Number(value.slope),
    cutoffStressMpa, source };
}

export function readHistory(value: unknown, path: string): FatigueStressHistory | FatigueError {
  if (!record(value) || !exactKeys(value, ['id', 'unit', 'stressMpa', 'sequence', 'repeats', 'source'])) return fail('fatigue-shape', path);
  if (!text(value.id, 64)) return fail('fatigue-id', `${path}.id`);
  if (value.unit !== 'MPa') return fail('fatigue-unit', `${path}.unit`);
  const points = value.stressMpa;
  if (!dense(points)) return fail('fatigue-shape', `${path}.stressMpa`);
  if (points.length < 1 || points.length > MAX_FATIGUE_HISTORY_POINTS) return fail('fatigue-history', `${path}.stressMpa`);
  const stress: number[] = [];
  for (const [index, point] of points.entries()) {
    if (!finite(point)) return fail('fatigue-number', `${path}.stressMpa[${index}]`);
    if (Math.abs(point) > MAX_FATIGUE_STRESS_MPA) return fail('fatigue-bound', `${path}.stressMpa[${index}]`);
    stress.push(point);
  }
  const sequence = value.sequence;
  if (sequence !== 'once' && sequence !== 'repeated-periodic') return fail('fatigue-sequence', `${path}.sequence`);
  const repeats = value.repeats;
  if (typeof repeats !== 'number' || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > MAX_FATIGUE_REPEATS
    || (sequence === 'once' && repeats !== 1)) return fail('fatigue-repeats', `${path}.repeats`);
  const source = readSource(value.source, `${path}.source`);
  if ('ok' in source) return source;
  return { id: value.id, unit: 'MPa', stressMpa: stress, sequence, repeats, source };
}

/** Strict reader of unknown data; returns fresh values so later caller mutation cannot change an analysis. */
export function validateFatigueInput(value: unknown): FatigueValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'curve', 'histories'])) return fail('fatigue-shape', '$');
  if (value.schema !== FATIGUE_INPUT_SCHEMA) return fail('fatigue-schema', 'schema');
  const curve = readFatigueSnCurve(value.curve);
  if ('ok' in curve) return curve;
  const rows = value.histories;
  if (!dense(rows)) return fail('fatigue-shape', 'histories');
  if (rows.length < 1 || rows.length > MAX_FATIGUE_HISTORIES) return fail('fatigue-history', 'histories');
  const histories: FatigueStressHistory[] = [];
  const ids = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const history = readHistory(row, `histories[${index}]`);
    if ('ok' in history) return history;
    if (ids.has(history.id)) return fail('fatigue-id', `histories[${index}].id`);
    ids.add(history.id);
    histories.push(history);
  }
  return { ok: true, input: { schema: FATIGUE_INPUT_SCHEMA, curve, histories } };
}

/** One rainflow cycle: `count` 1 for a closed cycle, 0.5 for a half cycle; indices are the first sample of each
 * reversal (plateau starts) in the original history; for closed-loop counting they refer to the same history. */
export interface FatigueCycle {
  readonly count: 0.5 | 1;
  readonly rangeMpa: number;
  readonly meanMpa: number;
  readonly fromIndex: number;
  readonly toIndex: number;
}
export interface FatigueHistoryResult {
  readonly id: string;
  readonly sequence: FatigueSequence;
  readonly repeats: number;
  readonly reversals: number;
  readonly cycles: readonly FatigueCycle[];
  /** Miner damage of this history including its repeats. */
  readonly damage: number;
}
/** No damaging cycle at all is a typed outcome, never JSON Infinity or a finite stand-in. */
export type FatigueLife =
  | { readonly kind: 'finite'; readonly spectrumRepetitions: number }
  | { readonly kind: 'no-damaging-cycle' }
  | { readonly kind: 'not-representable'; readonly reason: 'damage-underflow' | 'life-overflow' };
export interface FatigueResult {
  readonly schema: typeof FATIGUE_RESULT_SCHEMA;
  readonly method: 'rainflow-three-point-stack/1+miner-linear-single-slope/1';
  readonly scope: 'uniaxial-scalar-stress-history-linear-damage-estimate';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly curveId: string;
  readonly stressDefinition: FatigueStressDefinition;
  readonly meanStressAssumption: FatigueMeanStressAssumption;
  readonly histories: readonly FatigueHistoryResult[];
  /** Sum of n_i / N_i over every counted cycle of every history (Miner); not a probability of failure. */
  readonly damage: number;
  /** How many times the whole input spectrum (all histories with their repeats) could be applied until damage 1. */
  readonly life: FatigueLife;
}
export type FatigueAnalysis = { readonly ok: true; readonly result: FatigueResult } | FatigueError;

/** Separate opt-in contract: the legacy input/result and saved input schemas are unchanged. */
export const FATIGUE_GOODMAN_SCHEMA = 'pointercad-fatigue-goodman/1';
export const FATIGUE_CORRECTED_RESULT_SCHEMA = 'pointercad-fatigue-corrected-result/1';
/** This first elastic S-N slice excludes lives of 1000 cycles or fewer; users must state a stricter curve limit.
 * Basis: https://help.altair.com/hwdesktop/hlife/topics/solvers/os/analysis_fatigue_stress_life_approach_r.htm */
export const GOODMAN_MINIMUM_CYCLES_EXCLUSIVE = 1000;
export interface FatigueMeanStressCorrection {
  readonly schema: typeof FATIGUE_GOODMAN_SCHEMA;
  readonly method: 'goodman-tension-only/1';
  readonly unit: 'MPa';
  /** Explicit assertion of symmetric tensile/compressive yielding for this uniaxial elastic approximation. */
  readonly applicability: 'uniaxial-elastic-symmetric-yield';
  readonly ultimateTensileStrengthMpa: number;
  readonly yieldStrengthMpa: number;
  /** User-supplied lower validity limit of the fully reversed S-N relation (not a fitted or inferred value). */
  readonly minimumCycles: number;
  /** Source/condition must identify both strengths, the curve validity limit and their applicability. */
  readonly source: FatigueSource;
}
export type FatigueCorrectionErrorCode = 'fatigue-correction-schema' | 'fatigue-correction-method'
  | 'fatigue-correction-strength' | 'fatigue-correction-curve' | 'fatigue-correction-domain';
export interface FatigueCorrectionError { readonly ok: false; readonly code: FatigueCorrectionErrorCode; readonly path: string }
export type FatigueCorrectionValidation = { readonly ok: true; readonly correction: FatigueMeanStressCorrection }
  | FatigueError | FatigueCorrectionError;

/** Own exact keys and fresh source values: an unknown method/strength is never silently substituted. */
export function validateFatigueMeanStressCorrection(value: unknown): FatigueCorrectionValidation {
  const keys = ['schema', 'method', 'unit', 'applicability', 'ultimateTensileStrengthMpa', 'yieldStrengthMpa', 'minimumCycles', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('fatigue-shape', 'correction');
  if (value.schema !== FATIGUE_GOODMAN_SCHEMA) return { ok: false, code: 'fatigue-correction-schema', path: 'correction.schema' };
  if (value.method !== 'goodman-tension-only/1' || value.applicability !== 'uniaxial-elastic-symmetric-yield') {
    return { ok: false, code: 'fatigue-correction-method', path: 'correction.method' };
  }
  if (value.unit !== 'MPa') return fail('fatigue-unit', 'correction.unit');
  const ultimate = value.ultimateTensileStrengthMpa, yieldStrength = value.yieldStrengthMpa;
  for (const key of ['ultimateTensileStrengthMpa', 'yieldStrengthMpa'] as const) {
    const strength = value[key];
    if (!finite(strength)) return fail('fatigue-number', `correction.${key}`);
    if (strength <= 0 || strength > MAX_FATIGUE_STRESS_MPA) {
      return { ok: false, code: 'fatigue-correction-strength', path: `correction.${key}` };
    }
  }
  // Keep explicit narrowing at the unknown-data boundary; no numeric coercion.
  if (!finite(ultimate) || !finite(yieldStrength)) return fail('fatigue-number', 'correction');
  if (yieldStrength > ultimate) return { ok: false, code: 'fatigue-correction-strength', path: 'correction.yieldStrengthMpa' };
  const minimum = value.minimumCycles;
  if (!finite(minimum)) return fail('fatigue-number', 'correction.minimumCycles');
  if (minimum <= GOODMAN_MINIMUM_CYCLES_EXCLUSIVE || minimum > FATIGUE_REFERENCE_CYCLE_LIMITS.maximum) {
    return { ok: false, code: 'fatigue-correction-domain', path: 'correction.minimumCycles' };
  }
  const source = readSource(value.source, 'correction.source');
  if ('ok' in source) return source;
  return { ok: true, correction: { schema: FATIGUE_GOODMAN_SCHEMA, method: 'goodman-tension-only/1', unit: 'MPa',
    applicability: 'uniaxial-elastic-symmetric-yield', ultimateTensileStrengthMpa: ultimate, yieldStrengthMpa: yieldStrength,
    minimumCycles: minimum, source } };
}

export interface FatigueCorrectedHistoryResult extends FatigueHistoryResult {
  /** One value per unchanged rainflow cycle, in the curve's declared range/amplitude convention. */
  readonly equivalentStressMpa: readonly number[];
}
export interface FatigueCorrectedResult extends Omit<FatigueResult, 'schema' | 'method' | 'histories'> {
  readonly schema: typeof FATIGUE_CORRECTED_RESULT_SCHEMA;
  readonly method: 'rainflow-three-point-stack/1+goodman-tension-only/1+miner-linear-single-slope/1';
  /** Applicability of the reference curve, not a claim that the original counted means are zero. */
  readonly meanStressAssumption: 'fully-reversed-only';
  readonly correction: FatigueMeanStressCorrection;
  readonly histories: readonly FatigueCorrectedHistoryResult[];
}
export type FatigueCorrectedAnalysis = { readonly ok: true; readonly result: FatigueCorrectedResult }
  | FatigueError | FatigueCorrectionError;
