import { countRainflow, curveStressMpa, firstNonzeroMean, onceReversals, periodicReversals, recurrenceCycles, spectrumLife } from './fatigue.js';
import { FATIGUE_REFERENCE_CYCLE_LIMITS, FATIGUE_REFERENCE_STRESS_LIMITS_MPA, FATIGUE_SLOPE_LIMITS, MAX_FATIGUE_HISTORIES,
  readHistory, type FatigueCycle, type FatigueErrorCode, type FatigueHistoryResult, type FatigueLife, type FatigueMeanStressAssumption,
  type FatigueSource, type FatigueStressDefinition, type FatigueStressHistory } from './fatigueModel.js';

/**
 * Rainflow + Miner against ONE user-supplied piecewise (multi-slope) S-N relation. The counting, the history reader,
 * the recurrence rule, the mean-stress assumptions and the life are the unchanged single-slope ones (fatigue.ts,
 * fatigueModel.ts); only N(S) differs. Nothing here is a design code: no detail category, FAT class, grade or
 * endurance value is built in, and a user-entered curve does not by itself complete a weld or bolt assessment.
 *
 * Segment k starts at (fromStressMpa_k, fromCycles_k) and holds N = fromCycles_k * (fromStressMpa_k / S) ** slope_k down
 * to the next segment's start; the last one holds down to `endCycles`. Segments are given in increasing cycles and the
 * start of each later segment must lie on the previous line (continuity at the knee). Stresses above the first start
 * are outside the calibration and refused, never extrapolated. Below the stress at `endCycles` the curve either states
 * a cut-off (`'cutoff-at-end'`: zero damage) or nothing (`'none'`: the cycle is refused, not silently dropped).
 */
export const FATIGUE_PIECEWISE_INPUT_SCHEMA = 'pointercad-fatigue-piecewise/1';
export const FATIGUE_PIECEWISE_RESULT_SCHEMA = 'pointercad-fatigue-piecewise-result/1';
export const MAX_FATIGUE_PIECEWISE_SEGMENTS = 8;
/** Relative tolerance of the knee continuity check (the knee life recomputed from the previous segment). */
export const FATIGUE_PIECEWISE_CONTINUITY_TOLERANCE = 1e-9;

export type FatiguePiecewiseEnd = 'cutoff-at-end' | 'none';
export interface FatiguePiecewiseSegment {
  readonly fromStressMpa: number;
  readonly fromCycles: number;
  readonly slope: number;
}
/** Where and for what the user's calibration applies; required free text, not interpreted. */
export interface FatiguePiecewiseApplicability {
  readonly material: string;
  readonly detail: string;
  readonly scope: string;
}
export interface FatiguePiecewiseCurve {
  readonly id: string;
  readonly unit: 'MPa';
  readonly stressDefinition: FatigueStressDefinition;
  readonly meanStressAssumption: FatigueMeanStressAssumption;
  readonly segments: readonly FatiguePiecewiseSegment[];
  readonly endCycles: number;
  readonly end: FatiguePiecewiseEnd;
  readonly applicability: FatiguePiecewiseApplicability;
  readonly source: FatigueSource;
}
export interface FatiguePiecewiseInput {
  readonly schema: typeof FATIGUE_PIECEWISE_INPUT_SCHEMA;
  readonly curve: FatiguePiecewiseCurve;
  readonly histories: readonly FatigueStressHistory[];
}
export type FatiguePiecewiseErrorCode = FatigueErrorCode | 'fatigue-piecewise-order' | 'fatigue-piecewise-continuity'
  | 'fatigue-piecewise-domain' | 'fatigue-applicability';
export interface FatiguePiecewiseError { readonly ok: false; readonly code: FatiguePiecewiseErrorCode; readonly path: string }
export type FatiguePiecewiseValidation = { readonly ok: true; readonly input: FatiguePiecewiseInput } | FatiguePiecewiseError;
export interface FatiguePiecewiseResult {
  readonly schema: typeof FATIGUE_PIECEWISE_RESULT_SCHEMA;
  readonly method: 'rainflow-three-point-stack/1+miner-linear-piecewise/1';
  readonly scope: 'uniaxial-scalar-stress-history-linear-damage-estimate';
  readonly codeCompliance: false;
  readonly structuralCertification: false;
  readonly curveId: string;
  readonly stressDefinition: FatigueStressDefinition;
  readonly meanStressAssumption: FatigueMeanStressAssumption;
  readonly histories: readonly FatigueHistoryResult[];
  readonly damage: number;
  readonly life: FatigueLife;
}
export type FatiguePiecewiseAnalysis = { readonly ok: true; readonly result: FatiguePiecewiseResult } | FatiguePiecewiseError;

const fail = (code: FatiguePiecewiseErrorCode, path: string): FatiguePiecewiseError => ({ ok: false, code, path });
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

function readSource(value: unknown, path: string): FatigueSource | FatiguePiecewiseError {
  if (!record(value) || !exactKeys(value, ['kind', 'reference', 'condition'])) return fail('fatigue-shape', path);
  if (value.kind !== 'user-supplied' || !text(value.reference, 512) || !text(value.condition, 512)) return fail('fatigue-source', path);
  return { kind: 'user-supplied', reference: value.reference, condition: value.condition };
}
function readApplicability(value: unknown): FatiguePiecewiseApplicability | FatiguePiecewiseError {
  if (!record(value) || !exactKeys(value, ['material', 'detail', 'scope'])) return fail('fatigue-shape', 'curve.applicability');
  const { material, detail, scope } = value;
  if (!text(material, 512)) return fail('fatigue-applicability', 'curve.applicability.material');
  if (!text(detail, 512)) return fail('fatigue-applicability', 'curve.applicability.detail');
  if (!text(scope, 512)) return fail('fatigue-applicability', 'curve.applicability.scope');
  return { material, detail, scope };
}
function within(number: number, limits: { readonly minimum: number; readonly maximum: number }): boolean {
  return number >= limits.minimum && number <= limits.maximum;
}
/** N at stress S on one segment's line. */
const segmentLife = (segment: FatiguePiecewiseSegment, stress: number): number =>
  segment.fromCycles * (segment.fromStressMpa / stress) ** segment.slope;
/** The stress at which the last segment reaches `endCycles` (the declared end of the calibrated range). */
export function piecewiseEndStressMpa(curve: Pick<FatiguePiecewiseCurve, 'segments' | 'endCycles'>): number {
  const last = curve.segments[curve.segments.length - 1];
  if (last === undefined) return Number.NaN;
  return last.fromStressMpa * (last.fromCycles / curve.endCycles) ** (1 / last.slope);
}

function readSegments(value: unknown): FatiguePiecewiseSegment[] | FatiguePiecewiseError {
  if (!dense(value)) return fail('fatigue-shape', 'curve.segments');
  if (value.length < 1 || value.length > MAX_FATIGUE_PIECEWISE_SEGMENTS) return fail('fatigue-bound', 'curve.segments');
  const segments: FatiguePiecewiseSegment[] = [];
  for (const [index, item] of value.entries()) {
    const path = `curve.segments[${index}]`;
    if (!record(item) || !exactKeys(item, ['fromStressMpa', 'fromCycles', 'slope'])) return fail('fatigue-shape', path);
    const numbers = [['fromStressMpa', FATIGUE_REFERENCE_STRESS_LIMITS_MPA], ['fromCycles', FATIGUE_REFERENCE_CYCLE_LIMITS],
      ['slope', FATIGUE_SLOPE_LIMITS]] as const;
    for (const [key, limits] of numbers) {
      const number = item[key];
      if (!finite(number)) return fail('fatigue-number', `${path}.${key}`);
      if (!within(number, limits)) return fail('fatigue-bound', `${path}.${key}`);
    }
    const segment = { fromStressMpa: Number(item.fromStressMpa), fromCycles: Number(item.fromCycles), slope: Number(item.slope) };
    const previous = segments[segments.length - 1];
    if (previous !== undefined) {
      // Knees are explicit and ordered: more cycles at a lower stress than the previous start.
      if (!(segment.fromCycles > previous.fromCycles && segment.fromStressMpa < previous.fromStressMpa)) return fail('fatigue-piecewise-order', path);
      const expected = segmentLife(previous, segment.fromStressMpa);
      if (!(Math.abs(expected - segment.fromCycles) <= FATIGUE_PIECEWISE_CONTINUITY_TOLERANCE * segment.fromCycles)) {
        return fail('fatigue-piecewise-continuity', path);
      }
    }
    segments.push(segment);
  }
  return segments;
}

function readCurve(value: unknown): FatiguePiecewiseCurve | FatiguePiecewiseError {
  const keys = ['id', 'unit', 'stressDefinition', 'meanStressAssumption', 'segments', 'endCycles', 'end', 'applicability', 'source'];
  if (!record(value) || !exactKeys(value, keys)) return fail('fatigue-shape', 'curve');
  if (!text(value.id, 64)) return fail('fatigue-id', 'curve.id');
  if (value.unit !== 'MPa') return fail('fatigue-unit', 'curve.unit');
  const definition = value.stressDefinition;
  if (definition !== 'range' && definition !== 'amplitude') return fail('fatigue-curve-convention', 'curve.stressDefinition');
  const mean = value.meanStressAssumption;
  if (mean !== 'mean-independent' && mean !== 'fully-reversed-only') return fail('fatigue-mean-assumption', 'curve.meanStressAssumption');
  const segments = readSegments(value.segments);
  if (!Array.isArray(segments)) return segments;
  const endCycles = value.endCycles;
  if (!finite(endCycles)) return fail('fatigue-number', 'curve.endCycles');
  const last = segments[segments.length - 1];
  if (last === undefined || !(endCycles > last.fromCycles) || !within(endCycles, FATIGUE_REFERENCE_CYCLE_LIMITS)) {
    return fail('fatigue-bound', 'curve.endCycles');
  }
  const end = value.end;
  if (end !== 'cutoff-at-end' && end !== 'none') return fail('fatigue-shape', 'curve.end');
  const applicability = readApplicability(value.applicability);
  if ('ok' in applicability) return applicability;
  const source = readSource(value.source, 'curve.source');
  if ('ok' in source) return source;
  return { id: value.id, unit: 'MPa', stressDefinition: definition, meanStressAssumption: mean, segments, endCycles, end, applicability, source };
}

/** Strict reader of unknown data; returns fresh values. Histories use the unchanged single-slope reader. */
export function validateFatiguePiecewiseInput(value: unknown): FatiguePiecewiseValidation {
  if (!record(value) || !exactKeys(value, ['schema', 'curve', 'histories'])) return fail('fatigue-shape', '$');
  if (value.schema !== FATIGUE_PIECEWISE_INPUT_SCHEMA) return fail('fatigue-schema', 'schema');
  const curve = readCurve(value.curve);
  if ('ok' in curve) return curve;
  const histories = value.histories;
  if (!dense(histories)) return fail('fatigue-shape', 'histories');
  if (histories.length < 1 || histories.length > MAX_FATIGUE_HISTORIES) return fail('fatigue-history', 'histories');
  const read: FatigueStressHistory[] = [];
  const ids = new Set<string>();
  for (const [index, item] of histories.entries()) {
    const history = readHistory(item, `histories[${index}]`);
    if ('ok' in history) return history;
    if (ids.has(history.id)) return fail('fatigue-id', `histories[${index}].id`);
    ids.add(history.id);
    read.push(history);
  }
  return { ok: true, input: { schema: FATIGUE_PIECEWISE_INPUT_SCHEMA, curve, histories: read } };
}

/**
 * 1 / N for one curve stress S (same range/amplitude definition as the curve), or a typed outcome:
 * - 'domain' above the first segment's start, or below the end stress when the curve states no cut-off;
 * - 0 below the end stress when the curve states 'cutoff-at-end' (S equal to the end stress is still damaging).
 * At a knee both adjacent lines give the same N (continuity); the upper segment is used.
 * The inverse is formed directly ((S / S_k) ** m_k / N_k) so that small stresses underflow instead of overflowing N.
 */
export function piecewiseInverseLife(curve: FatiguePiecewiseCurve, stress: number): number | 'domain' {
  const first = curve.segments[0];
  if (first === undefined || !(stress > 0) || stress > first.fromStressMpa) return 'domain';
  const endStress = piecewiseEndStressMpa(curve);
  if (stress < endStress) return curve.end === 'cutoff-at-end' ? 0 : 'domain';
  let segment = first;
  for (const candidate of curve.segments) if (stress <= candidate.fromStressMpa) segment = candidate;
  // A stress exactly at a later segment's start lies on both lines; keep the upper one (identical N by continuity).
  for (const [at, candidate] of curve.segments.entries()) {
    if (at > 0 && stress === candidate.fromStressMpa) { segment = curve.segments[at - 1] ?? segment; break; }
  }
  return (stress / segment.fromStressMpa) ** segment.slope / segment.fromCycles;
}

/** Validates unknown input, counts every history with the existing rainflow and sums Miner damage on the piecewise
 * curve. The mean-stress assumption, recurrence counting and life are those of analyzeFatigue. Typed refusals. */
export function analyzeFatiguePiecewise(value: unknown): FatiguePiecewiseAnalysis {
  const checked = validateFatiguePiecewiseInput(value);
  if (!checked.ok) return checked;
  const { curve, histories } = checked.input;
  const results: FatigueHistoryResult[] = [];
  let total = 0, repeated = 0, anyDamaging = false, anyRecurrenceDamaging = false;
  const sum = (cycles: readonly FatigueCycle[], path: string): { damage: number; damaging: boolean } | FatiguePiecewiseError => {
    let damage = 0, damaging = false;
    const endStress = piecewiseEndStressMpa(curve);
    for (const [index, cycle] of cycles.entries()) {
      const stress = curveStressMpa(curve, cycle);
      const inverse = piecewiseInverseLife(curve, stress);
      if (inverse === 'domain') return fail('fatigue-piecewise-domain', `${path}[${index}]`);
      // Damaging means on the calibrated curve (not cut off), even when its 1/N underflows to 0.
      if (stress >= endStress) damaging = true;
      damage += cycle.count * inverse;
    }
    return { damage, damaging };
  };
  for (const [at, history] of histories.entries()) {
    const reversals = history.sequence === 'once' ? onceReversals(history.stressMpa) : periodicReversals(history.stressMpa);
    const cycles = countRainflow(reversals), recurring = recurrenceCycles(history, cycles);
    if (curve.meanStressAssumption === 'fully-reversed-only') {
      const refused = firstNonzeroMean(history, cycles);
      if (refused >= 0) return fail('fatigue-mean', `histories[${at}].cycles[${refused}]`);
      const recurringRefused = recurring === cycles ? -1 : firstNonzeroMean(history, recurring);
      if (recurringRefused >= 0) return fail('fatigue-mean', `histories[${at}].recurrenceCycles[${recurringRefused}]`);
    }
    const single = sum(cycles, `histories[${at}].cycles`);
    if ('ok' in single) return single;
    if (single.damaging) anyDamaging = true;
    const damage = single.damage * history.repeats;
    if (!Number.isFinite(damage)) return fail('fatigue-overflow', `histories[${at}]`);
    let recurringDamage = damage;
    if (recurring !== cycles) {
      const again = sum(recurring, `histories[${at}].recurrenceCycles`);
      if ('ok' in again) return again;
      if (again.damaging) anyRecurrenceDamaging = true;
      recurringDamage = again.damage;
      if (!Number.isFinite(recurringDamage)) return fail('fatigue-overflow', `histories[${at}]`);
    }
    total += damage;
    repeated += recurringDamage;
    results.push({ id: history.id, sequence: history.sequence, repeats: history.repeats, reversals: reversals.length, cycles, damage });
  }
  if (!Number.isFinite(total) || !Number.isFinite(repeated)) return fail('fatigue-overflow', 'histories');
  const life = spectrumLife(anyDamaging || anyRecurrenceDamaging, anyDamaging && total === 0, repeated);
  return { ok: true, result: { schema: FATIGUE_PIECEWISE_RESULT_SCHEMA, method: 'rainflow-three-point-stack/1+miner-linear-piecewise/1',
    scope: 'uniaxial-scalar-stress-history-linear-damage-estimate', codeCompliance: false, structuralCertification: false,
    curveId: curve.id, stressDefinition: curve.stressDefinition, meanStressAssumption: curve.meanStressAssumption,
    histories: results, damage: total, life } };
}
